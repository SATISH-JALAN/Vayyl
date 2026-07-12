import { useRef, useState, type ChangeEvent } from 'react';

import Button from '../components/common/Button';
import Card from '../components/common/Card';
import { clearV2Notes, exportV2Backup, importV2Backup } from '../lib/storage';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';

export default function Settings() {
  const [message, setMessage] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const { address, keys } = useWalletStore();
  const { fetchState } = usePoolStore();

  const handleClearLocalNotes = async () => {
    if (!keys) {
      setMessage('Connect and unlock shielded keys before clearing local note storage.');
      return;
    }

    if (!window.confirm('Clear local notes from this browser? Export a backup first if you may need them again.')) return;

    await clearV2Notes(keys.viewingKey);
    await fetchState();
    setMessage('Local notes and activity were cleared.');
  };

  const handleExport = async () => {
    if (!keys) return setMessage('Unlock this workspace before exporting its encrypted backup.');
    const blob = new Blob([await exportV2Backup(keys.viewingKey)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `vayyl-note-backup-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage('Encrypted backup exported. It can only be opened with this wallet.');
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !keys) return setMessage('Unlock this workspace before importing a backup.');
    try {
      const count = await importV2Backup(keys.viewingKey, await file.text());
      await fetchState();
      setMessage(`Imported ${count} note${count === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Backup import failed.');
    }
  };

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Settings</h1>
          <p className="dapp-page-subtitle">Back up or restore your notes.</p>
        </div>
      </header>

      <div className="dapp-grid dapp-grid--settings">
        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Note backup</h2>
              <p className="dapp-card__description">Backups are encrypted and bound to the connected wallet.</p>
            </div>
          </div>
          <div className="dapp-setting-list">
            <div className="dapp-setting-row">
              <div>
                <strong>{address ? 'Connected wallet' : 'No wallet connected'}</strong>
                <p className="dapp-helper">
                  {keys ? 'Shielded keys are unlocked for this session.' : 'Shielded keys are not unlocked.'}
                </p>
              </div>
              <div className="dapp-setting-actions">
                <Button variant="ghost" type="button" onClick={handleExport} disabled={!keys}>Export backup</Button>
                <Button variant="ghost" type="button" onClick={() => importInput.current?.click()} disabled={!keys}>Import backup</Button>
                <input ref={importInput} className="dapp-file-input" type="file" accept="application/json,.json" onChange={handleImport} />
                <Button variant="ghost" type="button" onClick={handleClearLocalNotes} disabled={!keys}>Clear local notes</Button>
              </div>
            </div>
          </div>
          {message && <p className="dapp-status" role="status">{message}</p>}
        </Card>
      </div>
    </div>
  );
}
