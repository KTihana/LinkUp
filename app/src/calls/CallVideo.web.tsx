// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
export function CallVideo({ stream, local = false, video = true }: { stream: unknown; local?: boolean; video?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null), [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = ref.current; if (!element) return;
    element.srcObject = stream as MediaStream | null;
    if (stream) void element.play().catch(() => setBlocked(true));
    return () => { element.srcObject = null; };
  }, [stream]);
  return <><video ref={ref} autoPlay playsInline muted={local} aria-label={local ? 'Your camera' : 'Friend’s call'} style={{ width: video ? '100%' : 1, height: video ? '100%' : 1, objectFit: 'cover', transform: local ? 'scaleX(-1)' : undefined }} />
    {blocked && <button onClick={() => { void ref.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true)); }}>Play call audio</button>}</>;
}
