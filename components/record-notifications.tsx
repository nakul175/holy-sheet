"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { acceptedRecordNotifications, recordNotificationLabel, type RecordNotification } from "../lib/record-notifications-contract";

export default function RecordNotifications({ workspaceId, tenantId, onOpen }: { workspaceId: string; tenantId: string; onOpen: (recordId: string) => void }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-notifications`;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RecordNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const response = await fetch(root, { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json();
      if (request !== generation.current) return;
      if (!response.ok) {
        setItems([]);
        setError(typeof payload?.error === "string" ? payload.error : "Notifications are unavailable.");
        return;
      }
      const list = acceptedRecordNotifications(payload);
      setItems(list?.notifications ?? []);
      setError(list ? "" : "Notifications are unavailable.");
    } catch {
      if (request !== generation.current) return;
      setItems([]);
      setError("Notifications are unavailable.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    setLoading(true);
    void load();
    const timer = window.setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      generation.current += 1;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, open]);

  async function openNotification(item: RecordNotification) {
    try {
      const response = await fetch(root, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      if (!response.ok) {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
        setError("This notification is no longer available. Access may have changed.");
        void load();
        return;
      }
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: entry.readAt ?? new Date().toISOString() } : entry));
      onOpen(item.recordId);
    } catch {
      setError("This notification is no longer available. Access may have changed.");
    }
  }

  return (
    <section className="record-notifications" aria-label="Record notifications">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "Hide record notifications" : "Record notifications"}</button>
      {open && (loading ? <p role="status">Loading current notifications…</p> : error ? <p role="alert">{error}</p> : items.length ? (
        <ul className="notification-list">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className="notification-link" onClick={() => void openNotification(item)}>
                <strong>{!item.readAt && <span aria-label="Unread">● </span>}{item.recordName}</strong>
                <small>{recordNotificationLabel(item.reason)} · {item.authorName} · {new Date(item.createdAt).toLocaleString()}</small>
              </button>
              <p>{item.body.slice(0, 240)}</p>
            </li>
          ))}
        </ul>
      ) : <p>No accessible record notifications yet.</p>)}
    </section>
  );
}
