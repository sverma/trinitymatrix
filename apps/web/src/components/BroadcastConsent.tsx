import { useEffect, useState } from "react";
import { api } from "../api";
import "./broadcast-consent.css";

export function BroadcastConsent({checked,onChange}:{checked:boolean;onChange:(value:boolean)=>void}) {
  const [available,setAvailable]=useState(false);
  useEffect(()=>{const controller=new AbortController();
    api.liveCapabilities(controller.signal).then(result=>{if(!controller.signal.aborted){setAvailable(result.enabled);if(!result.enabled)onChange(false);}})
      .catch(()=>{if(!controller.signal.aborted){setAvailable(false);onChange(false);}});
    return()=>controller.abort();
  },[onChange]);
  if(!available)return null;
  return <label className="broadcast-consent">
    <input type="checkbox" checked={checked} onChange={event=>onChange(event.target.checked)} />
    <span><strong>Broadcast this match</strong><span>All players’ hands and moves will be visible to signed-in spectators after a two-minute delay. You’ll play with others who also agree. Video sharing is optional, and you can stop sharing the match.</span></span>
  </label>;
}
