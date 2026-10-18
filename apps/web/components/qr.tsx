'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** QR code de vérification d'un document (CDC §4.11) : pointe vers la page publique /verifier/<code>. */
export function VerifyQr({ code, size = 96 }: { code: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(`${window.location.origin}/verifier/${code}`, { margin: 0, width: size * 2, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => setSrc(null));
  }, [code, size]);
  return (
    <div className="grid justify-items-center gap-1 text-center">
      {src ? <img src={src} alt={`QR code de vérification ${code}`} width={size} height={size} /> : <div style={{ width: size, height: size }} className="bg-sunk" />}
      <span className="font-mono text-[10px] tracking-wider">{code}</span>
    </div>
  );
}
