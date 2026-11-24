import StepPlaceholder from '../components/StepPlaceholder.jsx';

export default function MediaLab() {
  return (
    <StepPlaceholder title="Media Lab" steps="Step 3 (camera/mic) and Step 4 (devices & controls)">
      Capture your camera and microphone with getUserMedia, show a local preview,
      list devices with enumerateDevices, switch camera/mic, and mute/unmute tracks.
    </StepPlaceholder>
  );
}
