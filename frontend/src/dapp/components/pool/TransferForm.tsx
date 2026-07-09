import Card from '../common/Card';

export default function TransferForm() {
  return (
    <Card>
      <div className="dapp-empty">
        <strong>Shielded transfer is not enabled</strong>
        <p>Transfer is unavailable in the current pool configuration.</p>
      </div>
    </Card>
  );
}
