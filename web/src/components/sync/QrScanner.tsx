import { useEffect, useRef, useState } from "react";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import jsQR from "jsqr";
import { isNative } from "../../utils/nativeSongs";

type Props = {
  /** prompt shown above the scanner */
  title: string;
  /** which payload to accept: "O" = offer, "A" = answer */
  expect: "O" | "A";
  onFound: (data: string) => void;
  onCancel: () => void;
  /** passive: compact strip that keeps watching (no cancel button) */
  passive?: boolean;
};

/**
 * QR scanner that lives inside the sync modal.
 *  - native: the OS barcode scanner (fullscreen, returns once)
 *  - web: getUserMedia + jsQR preview with a paste fallback
 */
export function QrScanner({
  title,
  expect,
  onFound,
  onCancel,
  passive = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const foundRef = useRef(false);

  const accept = (data: string) => {
    if (foundRef.current) return;
    if (data.charAt(0) !== expect) return;
    foundRef.current = true;
    onFound(data);
  };

  useEffect(() => {
    if (!isNative()) return;
    void (async () => {
      try {
        const { ScanResult } = await CapacitorBarcodeScanner.scanBarcode({
          hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
          scanInstructions: title,
          scanButton: false,
        });
        if (ScanResult) accept(ScanResult);
        else onCancel();
      } catch {
        onCancel();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isNative()) return;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let cancelled = false;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const loop = () => {
          timer = window.setTimeout(() => {
            const el = videoRef.current;
            if (el && el.readyState >= 2) {
              const w = Math.min(480, el.videoWidth);
              const h = Math.round((el.videoHeight / el.videoWidth) * w);
              const cvs = document.createElement("canvas");
              cvs.width = w;
              cvs.height = h;
              const ctx = cvs.getContext("2d", { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(el, 0, 0, w, h);
                const img = ctx.getImageData(0, 0, w, h);
                const hit = jsQR(img.data, w, h, {
                  inversionAttempts: "dontInvert",
                });
                if (hit?.data) accept(hit.data);
              }
            }
            if (!cancelled && !foundRef.current) loop();
          }, 120);
        };
        loop();
      } catch {
        if (!cancelled) setCameraError("Camera unavailable — paste the code instead.");
      }
    })();

    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`sync-scan${passive ? " is-passive" : ""}`}>
      {!passive && <p className="sync-scan-title">{title}</p>}
      {!isNative() && (
        <div className="sync-scan-video">
          {cameraError ? (
            <p className="sync-hint">{cameraError}</p>
          ) : (
            <video ref={videoRef} playsInline muted />
          )}
        </div>
      )}
      {!isNative() && (
        <div className="sync-scan-paste">
          <input
            type="text"
            placeholder={`Paste the ${expect === "O" ? "offer" : "answer"} code…`}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && paste.trim()) accept(paste.trim());
            }}
          />
          <button
            type="button"
            className="sync-ghost"
            disabled={!paste.trim()}
            onClick={() => accept(paste.trim())}
          >
            Apply
          </button>
        </div>
      )}
      {!passive && (
        <button type="button" className="sync-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
