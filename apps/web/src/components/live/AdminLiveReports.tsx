import { useEffect, useState } from "react";
import { api, type BroadcastReport } from "../../api";
import { watchPath } from "./LiveDirectory";

export function AdminLiveReports() {
  const [reports, setReports] = useState<BroadcastReport[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    api.broadcastReports().then((value) => { if (active) { setReports(value.reports); setCursor(value.nextCursor); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Reports could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  const resolve = async (report: BroadcastReport, removeComment: boolean) => {
    setAction(report.id); setError("");
    try { await api.resolveBroadcastReport(report.id, removeComment); setReports((current) => current.filter((entry) => entry.id !== report.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The report could not be resolved."); }
    finally { setAction(null); }
  };
  return <section className="admin-live-reports" aria-labelledby="live-reports-title"><div className="section-heading admin-heading"><div><span className="eyebrow">Broadcast moderation</span><h1 id="live-reports-title">Spectator reports</h1></div><button className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh reports</button></div>
    {loading && <p role="status">Loading spectator reports…</p>}{error && <p className="live-error" role="alert">{error}</p>}
    {!loading && reports.length === 0 && <div className="admin-card"><h2>No pending reports</h2><p>Reports of released spectator comments will appear here.</p></div>}
    {reports.map((report) => <article className="admin-card" key={report.id}><h2><a href={watchPath(report.broadcastName)}>{report.broadcastName}</a></h2><p><strong>{report.comment.displayName}</strong>: {report.comment.deleted ? "Message already removed." : report.comment.message}</p><p>Report: {report.reason}</p><div className="live-card-actions"><button className="secondary" disabled={action !== null} onClick={() => void resolve(report, false)}>Dismiss report</button><button className="danger" disabled={action !== null} onClick={() => void resolve(report, true)}>Remove reported message</button></div></article>)}
    {cursor && <button className="secondary" disabled={action !== null} onClick={() => { setAction("more"); void api.broadcastReports(cursor).then((value) => { setReports((current) => [...new Map([...current, ...value.reports].map((report) => [report.id, report])).values()]); setCursor(value.nextCursor); }).catch((cause) => setError(cause instanceof Error ? cause.message : "More reports could not be loaded.")).finally(() => setAction(null)); }}>Load more reports</button>}
  </section>;
}
