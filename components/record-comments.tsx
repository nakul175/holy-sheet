"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { acceptedFollow } from "../lib/record-follow-contract";
import {
  acceptedComment,
  acceptedCommentList,
  acceptedMentionPeople,
  bodyIncludesMention,
  commentBodyParts,
  type RecordComment,
  type RecordCommentMention,
} from "../lib/record-comments-contract";

function CommentBody({ body, mentions }: { body: string; mentions: readonly RecordCommentMention[] }) {
  return (
    <p>
      {commentBodyParts(body, mentions).map((part, index) => part.mentionId ? <mark className="record-mention" key={`${part.mentionId}:${index}`}>{part.text}</mark> : <span key={index}>{part.text}</span>)}
    </p>
  );
}

export default function RecordComments({ workspaceId, tenantId, recordId }: { workspaceId: string; tenantId: string; recordId: string }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records/${encodeURIComponent(recordId)}/comments`;
  const followRoot = root.replace(/\/comments$/, "/follow");
  const [comments, setComments] = useState<RecordComment[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [body, setBody] = useState("");
  const [selected, setSelected] = useState<RecordCommentMention[]>([]);
  const [people, setPeople] = useState<RecordCommentMention[]>([]);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [personIndex, setPersonIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState("");
  const [followNotice, setFollowNotice] = useState("");
  const pending = useRef<{ operationId: string; body: string; mentionIds: string[] } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const tooLong = [...body].length > 10000;

  useEffect(() => {
    const abort = new AbortController();
    setDenied(false);
    setError("");
    setFollowing(null);
    setFollowError("");
    setFollowNotice("");
    void (async () => {
      try {
        const response = await fetch(root, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
        const payload = await response.json();
        if (abort.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setDenied(true);
          setComments([]);
          return;
        }
        if (!response.ok) {
          setError("Comments are temporarily unavailable.");
          return;
        }
        const list = acceptedCommentList(payload);
        setComments(list?.comments ?? []);
        setTruncated(list?.truncated ?? false);
        try {
          const followResponse = await fetch(followRoot, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
          const followPayload = await followResponse.json();
          if (abort.signal.aborted) return;
          if (followResponse.ok) setFollowing(acceptedFollow(followPayload)?.following ?? null);
          else setFollowError("Following is temporarily unavailable.");
        } catch {
          if (!abort.signal.aborted) setFollowError("Following is temporarily unavailable.");
        }
      } catch {
        if (!abort.signal.aborted) setError("Comments are temporarily unavailable.");
      }
    })();
    return () => abort.abort();
  }, [followRoot, root]);

  async function toggleFollow() {
    if (following === null || followBusy || denied) return;
    setFollowBusy(true);
    setFollowError("");
    setFollowNotice("");
    try {
      const response = await fetch(followRoot, {
        method: following ? "DELETE" : "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json();
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        setFollowing(null);
        setFollowError("Following is not available with your current access.");
        return;
      }
      const next = acceptedFollow(payload);
      if (!response.ok || !next) {
        setFollowError(payload && typeof payload === "object" && typeof payload.error === "string" ? payload.error : "Could not update following.");
        return;
      }
      setFollowing(next.following);
      setFollowNotice(next.following ? "You follow this record." : "You unfollowed this record.");
    } catch {
      setFollowError("Could not update following.");
    } finally {
      setFollowBusy(false);
    }
  }

  useEffect(() => {
    setPeople([]);
    setPersonIndex(0);
    if (!mention || [...mention.query.trim()].length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`${root}?q=${encodeURIComponent(mention.query)}`, { credentials: "same-origin", cache: "no-store", signal: abort.signal })
        .then(async (response) => {
          const payload = await response.json();
          if (!abort.signal.aborted && response.ok) setPeople(acceptedMentionPeople(payload) ?? []);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [mention, root]);

  function addMention(person: RecordCommentMention) {
    if (!mention) return;
    setBody(body.slice(0, mention.start) + `@${person.name} ` + body.slice(mention.end));
    setSelected((current) => [...current.filter((item) => item.id !== person.id), person]);
    setMention(null);
    setPeople([]);
    textarea.current?.focus();
  }

  async function post(event: FormEvent) {
    event.preventDefault();
    const mentionIds = selected.filter((person) => bodyIncludesMention(body, person.name)).map((person) => person.id);
    if (busy || denied || !body.trim() || tooLong) return;
    const input = pending.current && pending.current.body === body && pending.current.mentionIds.join("\0") === mentionIds.join("\0")
      ? pending.current
      : { operationId: crypto.randomUUID(), body, mentionIds };
    pending.current = input;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(root, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await response.json();
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        pending.current = null;
        setDenied(true);
        setError("Comments are not available with your current access.");
        return;
      }
      const comment = payload && typeof payload === "object" ? acceptedComment((payload as { comment?: unknown }).comment) : null;
      if (!response.ok || !comment) {
        if (response.status < 500) pending.current = null;
        setError(typeof payload?.error === "string" ? payload.error : "Could not save the comment.");
        return;
      }
      pending.current = null;
      setComments((current) => current.some((item) => item.id === comment.id) ? current : [...current, comment]);
      setBody("");
      setSelected([]);
      setMention(null);
      setNotice(payload.replayed ? "This comment was already saved." : "Comment posted.");
    } catch {
      setError("Could not save the comment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Record comments" className="record-comments">
      <h3>Comments</h3>
      <p>Comments stay on this record. Mention someone who can already view it. A mention does not grant access.</p>
      {(following !== null || followError) && (
        <div className="record-follow" role="group" aria-label="Follow record">
          <p>Follow this record to be notified about new comments. Following does not grant access.</p>
          {following !== null && <button type="button" disabled={followBusy} onClick={() => void toggleFollow()}>{following ? "Unfollow" : "Follow"}</button>}
          {followNotice && <p role="status">{followNotice}</p>}
          {followError && <p role="alert">{followError}</p>}
        </div>
      )}
      {truncated && <p>Older comments are not shown.</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {denied && !error && <p role="alert">Comments are not available with your current access.</p>}
      {comments.length ? (
        <ol>
          {comments.map((comment) => (
            <li key={comment.id}>
              <strong>{comment.authorName}</strong>{" "}
              <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
              <CommentBody body={comment.body} mentions={comment.mentions} />
            </li>
          ))}
        </ol>
      ) : !denied && <p>No comments yet.</p>}
      {!denied && (
        <form aria-label="Write a record comment" onSubmit={post}>
          <label>
            Write a comment
            <textarea
              ref={textarea}
              value={body}
              disabled={busy}
              placeholder="Write a comment. Type @ and a name to mention someone."
              onChange={(event) => {
                const next = event.target.value;
                const cursor = event.target.selectionStart;
                const prefix = next.slice(0, cursor);
                const match = /@([^@\n]{0,80})$/.exec(prefix);
                setBody(next);
                setMention(match ? { start: prefix.lastIndexOf("@"), end: cursor, query: match[1] } : null);
              }}
              onKeyDown={(event) => {
                if (!people.length || !mention) return;
                if (event.key === "ArrowDown") { event.preventDefault(); setPersonIndex((index) => Math.min(people.length - 1, index + 1)); }
                if (event.key === "ArrowUp") { event.preventDefault(); setPersonIndex((index) => Math.max(0, index - 1)); }
                if (event.key === "Enter") { event.preventDefault(); addMention(people[personIndex]); }
                if (event.key === "Escape") { event.preventDefault(); setMention(null); setPeople([]); }
              }}
            />
          </label>
          {!!people.length && mention && (
            <div className="mention-options" role="listbox" aria-label="Workspace members who can view this record">
              {people.map((person, index) => (
                <button key={person.id} type="button" role="option" aria-selected={index === personIndex} onClick={() => addMention(person)}>{person.name}</button>
              ))}
            </div>
          )}
          <p>{[...body].length.toLocaleString()} / 10,000. A mention does not grant access.</p>
          <button disabled={busy || !body.trim() || tooLong}>Post comment</button>
        </form>
      )}
    </section>
  );
}
