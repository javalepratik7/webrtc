// Renders a MediaStream in a <video>.
//
// Why not <video srcObject={stream}>? React turns unknown JSX props into HTML
// *attributes*, and attributes are strings. srcObject is a DOM *property* that
// holds a live object (a MediaStream), and it has no attribute equivalent. So we
// grab the real DOM element with a ref and assign the property ourselves in an effect.
// (The old way, src={URL.createObjectURL(stream)}, was removed from browsers.)
import { useEffect, useRef } from 'react';

export default function VideoTile({ stream, muted = false, mirrored = false, label }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream ?? null;
    // Detach on change/unmount so the element doesn't keep a stopped stream around.
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <figure className="video-tile">
      <video
        ref={videoRef}
        autoPlay // start playing as soon as a stream is attached
        playsInline // iOS: play inside the page instead of going fullscreen
        muted={muted} // local preview: don't play your own mic back to you
        className={mirrored ? 'mirrored' : undefined}
      />
      {!stream && <div className="video-placeholder">No video</div>}
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}
