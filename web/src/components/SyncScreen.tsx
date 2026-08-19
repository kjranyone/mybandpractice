import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { QrCanvas } from "./sync/QrCanvas";
import { QrScanner } from "./sync/QrScanner";
import { formatDuration } from "../utils/format";
import {
  formatBytes,
  parseMessage,
  type SyncManifest,
} from "../utils/p2pProtocol";
import {
  createAnswerFromOffer,
  type SyncClient,
  type SyncProgress,
} from "../utils/p2pSync";
import {
  applyAnswer,
  createOfferConnection,
  type SyncSender,
} from "../utils/p2pSender";
import { defaultSyncFs } from "../utils/syncFs";
import { isNative } from "../utils/nativeSongs";

type Phase =
  | "choose"
  | "send-offer" // showing our offer QR
  | "send-answer-scan" // scanning the receiver's answer
  | "send-hash" // connected, hashing library
  | "send-wait" // manifest sent, receiver is picking
  | "sending"
  | "receive-scan" // scanning the sender's offer
  | "receive-answer" // showing our answer QR
  | "picking"
  | "receiving"
  | "done"
  | "error";

type SendConn = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  sender: SyncSender;
  manifest: SyncManifest | null;
};

type Props = {
  onClose: () => void;
  onLibraryChanged: () => void;
};

export function SyncScreen({ onClose, onLibraryChanged }: Props) {
  const [phase, setPhase] = useState<Phase>("choose");
  const [error, setError] = useState<string | null>(null);
  const [offerPayload, setOfferPayload] = useState<string | null>(null);
  const [answerPayload, setAnswerPayload] = useState<string | null>(null);
  const [manifest, setManifest] = useState<SyncManifest | null>(null);
  const [upToDate, setUpToDate] = useState<Map<string, boolean>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedSetlists, setSelectedSetlists] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [sendLabel, setSendLabel] = useState<string>("");
  const [sendBytes, setSendBytes] = useState<{ sent: number; total: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const sendRef = useRef<SendConn | null>(null);
  const clientRef = useRef<SyncClient | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    return () => {
      sendRef.current?.pc.close();
      clientRef.current?.close();
    };
  }, []);

  const fail = (message: string) => {
    setError(message);
    setPhase("error");
  };

  const finish = (changed: boolean) => {
    doneRef.current = true;
    setPhase("done");
    if (changed) onLibraryChanged();
  };

  // ---- sender flow ----

  const startSend = async () => {
    setBusy(true);
    try {
      const { pc, dc, sender, offerPayload } = await createOfferConnection(
        defaultSyncFs(),
      );
      const conn: SendConn = { pc, dc, sender, manifest: null };
      sendRef.current = conn;
      setOfferPayload(offerPayload);
      setPhase("send-offer");

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" &&
          !doneRef.current &&
          phaseRef.current !== "sending"
        ) {
          fail("Connection failed");
        }
      };

      dc.onopen = () => {
        void (async () => {
          setPhase("send-hash");
          try {
            const m = await sender.buildManifest((name) =>
              setSendLabel(`Hashing ${name}…`),
            );
            conn.manifest = m;
            sender.sendManifest(m);
            setSendLabel(
              `Library ready — ${m.songs.length} songs, ${m.setlists.length} setlists.`,
            );
            setPhase("send-wait");
          } catch (e) {
            fail(e instanceof Error ? e.message : "Failed to read library");
          }
        })();
      };

      dc.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        const msg = parseMessage(ev.data);
        if (!msg) return;
        switch (msg.type) {
          case "want":
            if (!conn.manifest) return;
            setPhase("sending");
            setSendLabel("Sending…");
            void sender
              .sendWanted(conn.manifest, msg.slugs, msg.setlists, (sent, total, name) => {
                setSendBytes({ sent, total });
                setSendLabel(name);
              })
              .then(() => finish(false))
              .catch((e: unknown) => {
                fail(e instanceof Error ? e.message : "Send failed");
              });
            break;
          case "ack":
            sender.onAck(msg.id, msg.ok, msg.error);
            break;
          default:
            break;
        }
      };
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not create connection");
    } finally {
      setBusy(false);
    }
  };

  const scanAnswer = () => {
    setPhase("send-answer-scan");
  };

  const onAnswerFound = async (data: string) => {
    const conn = sendRef.current;
    if (!conn) return;
    setBusy(true);
    try {
      await applyAnswer(conn.pc, data);
      setSendLabel("Connecting…");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Bad answer code");
    } finally {
      setBusy(false);
    }
  };

  // ---- receiver flow ----

  const startReceive = () => {
    setPhase("receive-scan");
  };

  const onOfferFound = async (data: string) => {
    setBusy(true);
    try {
      const { answerPayload, client } = await createAnswerFromOffer(
        data,
        defaultSyncFs(),
        {
        onManifest: (m) => {
          setManifest(m);
          setSelected(new Set(m.songs.map((s) => s.slug)));
          setSelectedSetlists(new Set(m.setlists.map((s) => s.id)));
          void client.checkUpToDate(m).then(setUpToDate);
          setPhase("picking");
        },
        onProgress: setProgress,
        onDone: () => finish(true),
        onError: (message) => {
          if (!doneRef.current) fail(message);
        },
      });
      clientRef.current = client;
      setAnswerPayload(answerPayload);
      setPhase("receive-answer");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  };

  const startTransfer = () => {
    if (!manifest || (selected.size === 0 && selectedSetlists.size === 0)) return;
    setPhase("receiving");
    clientRef.current?.sendWant(manifest, [...selected], [...selectedSetlists]);
  };

  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  // ---- pick helpers ----

  const toggle = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const toggleSetlist = (id: string) => {
    setSelectedSetlists((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedBytes =
    (manifest?.songs ?? [])
      .filter((s) => selected.has(s.slug))
      .reduce((a, s) => a + s.totalBytes, 0) +
    (manifest?.setlists ?? [])
      .filter((s) => selectedSetlists.has(s.id))
      .reduce((a, s) => a + s.totalBytes, 0);

  const reset = () => {
    sendRef.current?.pc.close();
    sendRef.current = null;
    clientRef.current?.close();
    clientRef.current = null;
    doneRef.current = false;
    setManifest(null);
    setProgress(null);
    setOfferPayload(null);
    setAnswerPayload(null);
    setSendLabel("");
    setSendBytes(null);
    setError(null);
    setPhase("choose");
  };

  const stepLabel = (() => {
    switch (phase) {
      case "send-offer":
      case "send-answer-scan":
        return "Send · connect";
      case "send-hash":
      case "send-wait":
      case "sending":
        return "Send · transfer";
      case "receive-scan":
      case "receive-answer":
        return "Receive · connect";
      case "picking":
      case "receiving":
        return "Receive · transfer";
      default:
        return null;
    }
  })();

  return (
    <Modal
      title="Sync"
      sub={stepLabel ? stepLabel : "between devices"}
      onClose={onClose}
      className="sync-card"
      overlayClassName="sync-overlay"
    >
      <div className="sync-body">
        {phase === "choose" && (
          <div className="sync-choose">
            <div className="sync-choose-grid">
              <button
                type="button"
                className="sync-choose-card"
                disabled={busy}
                onClick={() => void startSend()}
              >
                <span className="sync-choose-icon" aria-hidden>
                  ⇧
                </span>
                <span className="sync-choose-title">Send</span>
                <span className="sync-choose-sub">
                  Share this library with another device
                </span>
              </button>
              <button
                type="button"
                className="sync-choose-card"
                disabled={busy}
                onClick={startReceive}
              >
                <span className="sync-choose-icon" aria-hidden>
                  ⇩
                </span>
                <span className="sync-choose-title">Receive</span>
                <span className="sync-choose-sub">
                  Copy songs from another device
                </span>
              </button>
            </div>
          </div>
        )}

        {phase === "send-offer" && offerPayload && (
          <div className="sync-center">
            <p className="sync-step">Show this code to the other device</p>
            <QrCanvas payload={offerPayload} className="sync-qr" />
            {isNative() ? (
              <button
                type="button"
                className="sync-primary"
                onClick={scanAnswer}
              >
                Scan answer code
              </button>
            ) : (
              <QrScanner
                passive
                title="Scan the answer code shown on the other device"
                expect="A"
                onFound={(d) => void onAnswerFound(d)}
                onCancel={scanAnswer}
              />
            )}
          </div>
        )}

        {phase === "send-answer-scan" && (
          <QrScanner
            title="Scan the answer code shown on the other device"
            expect="A"
            onFound={(d) => void onAnswerFound(d)}
            onCancel={() => setPhase("send-offer")}
          />
        )}

        {(phase === "send-hash" || phase === "send-wait") && (
          <div className="sync-center">
            <p className="sync-status-label">{sendLabel}</p>
          </div>
        )}

        {phase === "sending" && (
          <div className="sync-progress">
            <p className="sync-file">{sendLabel}</p>
            <div className="sync-bar">
              <i
                style={{
                  width: `${sendBytes && sendBytes.total > 0 ? Math.min(100, (sendBytes.sent / sendBytes.total) * 100) : 0}%`,
                }}
              />
            </div>
            {sendBytes && (
              <p className="sync-hint">
                {formatBytes(sendBytes.sent)} / {formatBytes(sendBytes.total)}
              </p>
            )}
          </div>
        )}

        {phase === "receive-scan" && (
          <QrScanner
            title="Scan the offer code shown on the other device"
            expect="O"
            onFound={(d) => void onOfferFound(d)}
            onCancel={() => setPhase("choose")}
          />
        )}

        {phase === "receive-answer" && answerPayload && (
          <div className="sync-center">
            <p className="sync-step">Show this code to the other device</p>
            <QrCanvas payload={answerPayload} className="sync-qr" />
          </div>
        )}

        {phase === "picking" && manifest && (
          <>
            <ul className="sync-list">
              {manifest.songs.map((song) => {
                const isUpToDate = upToDate.get(song.slug) ?? false;
                const checked = selected.has(song.slug);
                return (
                  <li key={song.slug}>
                    <label className={`sync-item${checked ? " is-checked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(song.slug)}
                      />
                      <span className="song-meta">
                        <span className="song-title">{song.title}</span>
                        <span className="song-artist">
                          {song.artist}
                          {song.hasStems ? " · stems" : ""}
                          {song.hasLyrics ? " · lyrics" : ""}
                        </span>
                      </span>
                      <span className="sync-item-side">
                        <span className="sync-size">
                          {formatBytes(song.totalBytes)}
                        </span>
                        <span className="sync-dur">
                          {formatDuration(song.durationSeconds)}
                          {isUpToDate ? " · up to date" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
              {manifest.songs.length === 0 && (
                <li className="empty-list">No songs on the other device</li>
              )}
            </ul>
            {manifest.setlists.length > 0 && (
              <>
                <p className="sync-section">Setlists</p>
                <ul className="sync-list">
                  {manifest.setlists.map((sl) => {
                    const checked = selectedSetlists.has(sl.id);
                    return (
                      <li key={sl.id}>
                        <label
                          className={`sync-item${checked ? " is-checked" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSetlist(sl.id)}
                          />
                          <span className="song-meta">
                            <span className="song-title">{sl.name}</span>
                            <span className="song-artist">
                              {sl.songs.length} songs
                            </span>
                          </span>
                          <span className="sync-item-side">
                            <span className="sync-size">
                              {formatBytes(sl.totalBytes)}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <div className="sync-footer">
              <span>
                {selected.size + selectedSetlists.size} selected ·{" "}
                {formatBytes(selectedBytes)}
              </span>
              <button
                type="button"
                className="sync-primary"
                disabled={selected.size + selectedSetlists.size === 0}
                onClick={startTransfer}
              >
                Receive
              </button>
            </div>
          </>
        )}

        {phase === "receiving" && (
          <div className="sync-progress">
            {progress ? (
              <>
                <p className="sync-file">{progress.name}</p>
                <div className="sync-bar">
                  <i
                    style={{
                      width: `${progress.totalBytes > 0 ? Math.min(100, (progress.totalReceived / progress.totalBytes) * 100) : 0}%`,
                    }}
                  />
                </div>
                <p className="sync-hint">
                  {formatBytes(progress.totalReceived)} /{" "}
                  {formatBytes(progress.totalBytes)} · file{" "}
                  {progress.filesDone +
                    (progress.fileReceived >= progress.fileBytes ? 0 : 1)}
                  /{progress.filesTotal}
                </p>
              </>
            ) : (
              <p className="sync-hint">Waiting for data…</p>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="sync-center">
            <p className="sync-done">✓ Sync complete</p>
            <button type="button" className="sync-primary" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="sync-center">
            <p className="sync-error">{error ?? "Sync failed"}</p>
            <button type="button" className="sync-primary" onClick={reset}>
              Try again
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
