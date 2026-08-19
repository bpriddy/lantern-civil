import { COMMANDS, formatChord } from './registry.js';

/**
 * Every shortcut and what it does. The descriptions are the same strings an agent
 * will match instructions against, so this doubles as a check that they read as
 * instructions rather than as labels.
 */
export function KeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="keyhelp-backdrop" onClick={onClose} role="presentation">
      <div className="keyhelp" onClick={(e) => e.stopPropagation()}>
        <div className="keyhelp-head">
          <span>Keyboard</span>
          <button type="button" className="link" onClick={onClose}>close</button>
        </div>
        <div className="keyhelp-body">
          {COMMANDS.map((command) => (
            <div key={command.id} className="keyhelp-row">
              <kbd className="keyhelp-chord">{formatChord(command.keys[0]!)}</kbd>
              <div>
                <div className="keyhelp-title">{command.title}</div>
                <div className="keyhelp-desc">{command.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
