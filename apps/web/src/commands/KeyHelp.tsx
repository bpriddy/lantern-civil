import { COMMANDS, formatChord, titleOf, type CommandContext } from './registry.js';

/**
 * Every shortcut and what it does. The descriptions are the same strings an agent
 * will match instructions against, so this doubles as a check that they read as
 * instructions rather than as labels. Titles read in the current context when one
 * is given ("Update graph from repo" once the project has a composition).
 */
export function KeyHelp({ onClose, context }: { onClose: () => void; context?: CommandContext }) {
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
                <div className="keyhelp-title">{context ? titleOf(command, context) : command.title}</div>
                <div className="keyhelp-desc">{command.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
