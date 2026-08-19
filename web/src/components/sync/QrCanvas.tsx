import { useEffect, useRef } from "react";
import QRCode from "qrcode";

type Props = {
  payload: string;
  className?: string;
  /** render the QR at a fixed module scale (default 4) */
  scale?: number;
};

/** Renders a compressed SDP payload as a QR code canvas.
 *  The canvas keeps square intrinsic dimensions so CSS `width/height`
 *  can scale it down responsively. */
export function QrCanvas({ payload, className, scale = 4 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void QRCode.toCanvas(el, payload, {
      errorCorrectionLevel: "L",
      margin: 1,
      scale,
      color: { dark: "#0b0d11", light: "#ffffff" },
    }).then(() => {
      // the library pins canvas.style.width/height inline (pixel size),
      // which defeats the responsive CSS — drop them so the class wins
      if (!cancelled) {
        el.style.width = "";
        el.style.height = "";
      }
    });
    return () => {
      cancelled = true;
    };
  }, [payload, scale]);

  return <canvas ref={ref} className={className} />;
}
