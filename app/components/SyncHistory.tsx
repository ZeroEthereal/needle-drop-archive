"use client";

import { useEffect, useRef, useState } from "react";
import type { SyncHistoryRecord } from "../ui-types";

interface HistoryPage {
  items: SyncHistoryRecord[];
  total: number;
  nextCursor: string | null;
}

function historyTime(value: string): string {
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(utc));
}

export default function SyncHistory() {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<HistoryPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const sequence = useRef({ value: 0 });

  useEffect(() => {
    const requests = sequence.current;
    let controller: AbortController | undefined;
    const load = async () => {
      const request = ++requests.value;
      controller?.abort();
      controller = new AbortController();
      setLoading(true);
      try {
        const response = await fetch(`/api/sync/history?offset=${offset}`, {
          credentials: "same-origin", headers: { Accept: "application/json" },
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("History unavailable");
        const next = await response.json() as HistoryPage;
        if (request !== requests.value) return;
        if (offset > 0 && offset >= next.total) {
          setOffset(Math.max(0, Math.ceil(next.total / 10) - 1) * 10);
          return;
        }
        setPage(next);
        setError(false);
      } catch {
        if (request === requests.value) setError(true);
      } finally {
        if (request === requests.value) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => {
      ++requests.value;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [offset, retry]);

  const changePage = (nextOffset: number) => {
    ++sequence.current.value;
    setPage(undefined);
    setError(false);
    setLoading(true);
    setOffset(nextOffset);
  };

  return <section className="sync-history glass-panel" aria-labelledby="sync-history-title" aria-busy={loading}>
    <div className="history-heading">
      <h3 id="sync-history-title">历史同步记录</h3>
      <p>近 7 天 · 北京时间 · 按完成时间排列</p>
    </div>
    {error ? <div className="history-message" role="status">
      <p>历史同步记录暂时无法加载。</p>
      <button type="button" className="quiet-button" disabled={loading} onClick={() => setRetry((value) => value + 1)}>重试</button>
    </div> : null}
    {!page && loading ? <p className="history-message" role="status">正在加载同步记录…</p> : null}
    {page?.items.length === 0 && !error ? <p className="history-message">近 7 天暂无同步记录</p> : null}
    {page && page.items.length > 0 ? <>
      <ol className="history-records">
        {page.items.map((record) => <li key={record.id} className={`history-record state-${record.status}`}>
          <div className="history-record-heading">
            <time dateTime={/^\d{4}-\d{2}-\d{2} /.test(record.completedAt)
              ? `${record.completedAt.replace(" ", "T")}Z` : record.completedAt}>{historyTime(record.completedAt)}</time>
            <span className="history-trigger">{record.trigger === "scheduled" ? "自动同步" : "手动同步"}</span>
            <p className="history-summary">
              {record.scope === "playlist" ? `${record.playlist?.name ?? "歌单"}同步` : "全部监控歌单同步"}
              <span className="history-result">{record.status === "success" ? "成功" : "失败"}</span>
              {record.scope === "all" && record.status === "failed"
                ? <span className="history-failure-count">（{record.failureCount} 个歌单失败）</span> : null}
            </p>
          </div>
          {record.scope === "all" && record.failedPlaylists.length > 0 ? <div className="history-failures">
            <span>失败歌单</span>
            <ul>{record.failedPlaylists.map((playlist) => <li key={playlist.id}>{playlist.name}</li>)}</ul>
          </div> : null}
        </li>)}
      </ol>
      <nav className="history-pagination" aria-label="同步记录分页">
        <button type="button" className="quiet-button" disabled={loading || offset === 0} onClick={() => changePage(Math.max(0, offset - 10))}>上一页</button>
        <span>第 {Math.floor(offset / 10) + 1} / {Math.max(1, Math.ceil(page.total / 10))} 页 · 共 {page.total} 条</span>
        <button type="button" className="quiet-button" disabled={loading || page.nextCursor === null} onClick={() => changePage(Number(page.nextCursor))}>下一页</button>
      </nav>
    </> : null}
  </section>;
}
