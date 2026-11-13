import { afterEach, describe, expect, it, vi } from "vitest";
import { Matchmaker, type GameArchive } from "./matchmaker";
import { MemoryStateStore, type StateStore } from "./persistence";

class Socket {
  readyState=1; sent: any[]=[];
  send(raw:string){this.sent.push(JSON.parse(raw));}
  close(){this.readyState=3;}
}
function fixture(onStart=vi.fn(async()=>undefined), store:StateStore=new MemoryStateStore()) {
  const archive:GameArchive={startPrivateGame:vi.fn(async()=>undefined),recordEvent:vi.fn(async()=>undefined),completeGame:vi.fn(async()=>undefined)};
  const matchmaker=new Matchmaker(store,vi.fn(),archive,onStart);
  const sockets=new Map<string,Socket>();
  for(const id of ["human-a","human-b","human-c","human-d"]){const socket=new Socket();sockets.set(id,socket);matchmaker.register({playerId:id,displayName:id,socket});}
  return {store,archive,matchmaker,sockets,onStart};
}

describe("consensual live table matchmaking",()=>{
  afterEach(()=>vi.useRealTimers());
  it("never mixes broadcast consent pools or publishes a nonconsenting hand",async()=>{
    const f=fixture();
    f.matchmaker.handle("human-a",{type:"queue.join",playerCount:2,broadcast:true});
    f.matchmaker.handle("human-b",{type:"queue.join",playerCount:2});
    expect([...f.sockets.values()].flatMap(s=>s.sent).filter(m=>m.type==="game.started")).toHaveLength(0);
    f.matchmaker.handle("human-c",{type:"queue.join",playerCount:2,broadcast:true});
    await f.matchmaker.flush();
    expect(f.onStart).toHaveBeenCalledTimes(1);
    const opted=f.sockets.get("human-a")!.sent.find(m=>m.type==="game.started");
    expect(opted.broadcast).toEqual({gameName:opted.gameName,delayMs:120000});
    expect(opted.players.map((p:any)=>p.id).sort()).toEqual(["human-a","human-c"]);
    expect(f.sockets.get("human-b")!.sent.at(-1)).toMatchObject({type:"queue.status",joined:1});
    f.matchmaker.handle("human-d",{type:"queue.join",playerCount:2});
    await f.matchmaker.flush();
    expect(f.onStart).toHaveBeenCalledTimes(1);
    expect(f.sockets.get("human-b")!.sent.find(m=>m.type==="game.started")).not.toHaveProperty("broadcast");
    f.matchmaker.shutdown();
  });
  it("persists consent separately so prior releases can still restore the gameplay snapshot",async()=>{
    const f=fixture();f.matchmaker.handle("human-a",{type:"queue.join",playerCount:2,broadcast:true});await f.matchmaker.flush();
    const gameplay=await f.store.get<any>("matchmaker:active-games");
    expect(gameplay).not.toHaveProperty("broadcastGames");expect(gameplay).not.toHaveProperty("broadcastQueuePlayers");
    expect(await f.store.get("matchmaker:broadcast-consent")).toEqual({queuedPlayerIds:["human-a"],gameIds:[]});
    f.matchmaker.shutdown();
    const resumed=new Matchmaker(f.store,vi.fn(),f.archive,f.onStart);await resumed.restore();
    const a=new Socket(),b=new Socket();resumed.register({playerId:"human-a",displayName:"A",socket:a});resumed.register({playerId:"human-b",displayName:"B",socket:b});
    resumed.handle("human-b",{type:"queue.join",playerCount:2});expect(b.sent.some(m=>m.type==="game.started")).toBe(false);
    resumed.handle("human-b",{type:"queue.join",playerCount:2,broadcast:true});await resumed.flush();
    expect(b.sent.find(m=>m.type==="game.started").broadcast.delayMs).toBe(120000);resumed.shutdown();
  });
  it("requires a durable broadcaster and never advertises unsupported consent",()=>{
    const matchmaker=new Matchmaker(new MemoryStateStore());const s=new Socket();matchmaker.register({playerId:"a",displayName:"A",socket:s});
    matchmaker.handle("a",{type:"queue.join",playerCount:2,broadcast:true});expect(s.sent.at(-1)).toMatchObject({type:"error",code:"BROADCAST_UNAVAILABLE"});matchmaker.shutdown();
  });
  it("fails closed if a legacy store crashes between the gameplay and consent writes",async()=>{
    const memory=new MemoryStateStore(); let crash=false;
    const store:StateStore={
      get:<T>(key:string)=>memory.get<T>(key),
      delete:key=>memory.delete(key),
      consumeChallenge:<T>(key:string,hash:string,now:number,max:number)=>memory.consumeChallenge<T>(key,hash,now,max),
      set:async(key,value,ttl)=>{await memory.set(key,value,ttl);if(crash&&key==="matchmaker:active-games")throw new Error("Simulated process loss between writes");}
    };
    const f=fixture(vi.fn(async()=>undefined),store);
    f.matchmaker.handle("human-a",{type:"queue.join",playerCount:2,broadcast:true});await f.matchmaker.flush();
    expect(await store.get("matchmaker:broadcast-consent")).toEqual({queuedPlayerIds:["human-a"],gameIds:[]});
    crash=true;f.matchmaker.handle("human-a",{type:"queue.join",playerCount:2});await f.matchmaker.flush();f.matchmaker.shutdown();
    expect(await store.get("matchmaker:broadcast-consent")).toBeNull();
    const resumed=new Matchmaker(store,vi.fn(),f.archive,f.onStart);await resumed.restore();
    const a=new Socket(),b=new Socket();resumed.register({playerId:"human-a",displayName:"A",socket:a});resumed.register({playerId:"human-b",displayName:"B",socket:b});
    resumed.handle("human-b",{type:"queue.join",playerCount:2,broadcast:true});
    expect(a.sent.some(m=>m.type==="game.started")).toBe(false);expect(b.sent.some(m=>m.type==="game.started")).toBe(false);
    resumed.shutdown();
  });
  it("does not hold rating archival hostage when the optional broadcast service fails",async()=>{
    vi.useFakeTimers();const f=fixture(vi.fn(async()=>{throw new Error("broadcast unavailable");}));
    f.matchmaker.handle("human-a",{type:"queue.join",playerCount:2,broadcast:true});f.matchmaker.handle("human-b",{type:"queue.join",playerCount:2,broadcast:true});
    await vi.advanceTimersByTimeAsync(1300);
    const started=f.sockets.get("human-a")!.sent.find(m=>m.type==="game.started");
    f.matchmaker.handle("human-a",{type:"game.drop",gameId:started.gameId,commandId:crypto.randomUUID(),expectedRevision:started.revision});
    await f.matchmaker.flush();expect(f.archive.completeGame).toHaveBeenCalledTimes(1);f.matchmaker.shutdown();
  });
});
