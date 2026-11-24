// Renders a MediaStream in a <video>.
//
// Why not <video srcObject={stream}>? React turns unknown JSX props into HTML
// *attributes*, and attributes are strings. srcObject is a DOM *property* that
// holds a live object (a MediaStream), and it has no attribute equivalent. So we
// grab the real DOM element with a ref and assign the property ourselves in an effect.
// (The old way, src={URL.createObjectURL(stream)}, was removed from browsers.)
//
// When tracks are added to / removed from the SAME stream (camera switch, screen
// share, remote tracks arriving one by one), the <video> follows automatically.
//
// children are rendered on top of the video (stats overlay, status badges...).
import { useEffect, useRef, useState } from 'react';
import { SINK_SUPPORTED } from './DeviceSelector.jsx';

export default function VideoTile({
  stream,
  muted = false,
  mirrored = false,
  label,
  sinkId = '',
  placeholder,
  className = '',
  children,
}) {
  const videoRef = useRef(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream ?? null;
    setBlocked(false);
    if (stream) {
      // autoPlay usually works, but unmuted playback (remote audio) can be blocked by the
      // autoplay policy if the user hasn't interacted with the page. Offer a click then.
      video.play().catch((err) => {
        if (err.name === 'NotAllowedError') setBlocked(true);
      });
    }
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  // Output device for this element's audio ('' = system default).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !SINK_SUPPORTED) return;
    video.setSinkId(sinkId).catch((err) => console.warn('setSinkId failed:', err));
  }, [sinkId]);

  return (
    <figure className={`video-tile ${className}`}>
      <video
        ref={videoRef}
        autoPlay // start playing as soon as a stream is attached
        playsInline // iOS: play inside the page instead of going fullscreen
        muted={muted} // local preview: don't play your own mic back to you
        className={mirrored ? 'mirrored' : undefined}
      />
      {(!stream || placeholder) && <div className="video-placeholder">{placeholder || 'No video'}</div>}
      {blocked && (
        <button
          className="video-unblock primary"
          onClick={() => videoRef.current?.play().then(() => setBlocked(false), () => {})}
        >
          ▶ Click to play (with sound)
        </button>
      )}
      {label && <figcaption>{label}</figcaption>}
      {children}
    </figure>
  );
}
