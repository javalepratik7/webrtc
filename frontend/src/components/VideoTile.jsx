// Renders a MediaStream in a <video>.
//
// Why not <video srcObject={stream}>? React turns unknown JSX props into HTML
// *attributes*, and attributes are strings. srcObject is a DOM *property* that
// holds a live object (a MediaStream), and it has no attribute equivalent. So we
// grab the real DOM element with a ref and assign the property ourselves in an effect.
// (The old way, src={URL.createObjectURL(stream)}, was removed from browsers.)
//
// When tracks are added to / removed from the SAME stream (camera switch, screen
// share), the <video> follows automatically: no need to re-assign srcObject.
import { useEffect, useRef } from 'react';
import { SINK_SUPPORTED } from './DeviceSelector.jsx';

export default function VideoTile({ stream, muted = false, mirrored = false, label, sinkId = '', placeholder }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream ?? null;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  // Output device for this element's audio ('' = system default). Matters for
  // remote video later; the local preview is muted anyway.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !SINK_SUPPORTED) return;
    video.setSinkId(sinkId).catch((err) => console.warn('setSinkId failed:', err));
  }, [sinkId]);

  return (
    <figure className="video-tile">
      <video
        ref={videoRef}
        autoPlay // start playing as soon as a stream is attached
        playsInline // iOS: play inside the page instead of going fullscreen
        muted={muted} // local preview: don't play your own mic back to you
        className={mirrored ? 'mirrored' : undefined}
      />
      {(!stream || placeholder) && <div className="video-placeholder">{placeholder || 'No video'}</div>}
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}
