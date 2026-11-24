import StepPlaceholder from '../components/StepPlaceholder.jsx';

export default function Room() {
  return (
    <StepPlaceholder
      title="Room"
      steps="Step 8 (Socket.IO signaling), Step 9 (data channel), Step 10 (video call)"
    >
      Join a room by name. The backend relays signaling over Socket.IO, then the two
      peers chat over an RTCDataChannel and finally run a full peer-to-peer video call.
    </StepPlaceholder>
  );
}
