import StepPlaceholder from '../components/StepPlaceholder.jsx';

export default function Loopback() {
  return (
    <StepPlaceholder title="Loopback" steps="Step 5 (loopback peer connection) and Step 6 (SDP & ICE inspection)">
      Two RTCPeerConnections in the same tab, connected to each other with no server.
      You will see the full offer/answer + ICE flow, then inspect the SDP text and ICE
      candidates it produces.
    </StepPlaceholder>
  );
}
