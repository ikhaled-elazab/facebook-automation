/*
 * ListEditor.tsx — an editable, ordered list of strings (a child collection:
 * comments / replies / dm_messages / groups).
 *
 * The API replaces each collection wholesale, so the editor holds the full array
 * and emits the whole array on every change. Each item is a textarea (comments
 * can be multi-line) or an input (group URLs). Add/remove/reorder-free (the API
 * preserves array order; the UI keeps insertion order). Empty trailing items are
 * the caller's responsibility to trim before submit (zod rejects empty strings).
 *
 * KEYS: items are keyed by a stable per-row id (NOT the array index) so editing
 * one row never remounts siblings and loses focus/caret.
 */
import { useRef } from 'react';
import { Button, TextArea, TextInput } from './ui';
import { IconPlus, IconTrash } from './icons';

interface ListEditorProps {
  items: string[];
  onChange: (next: string[]) => void;
  /** 'text' → multi-line textarea; 'url' → single-line input. */
  variant?: 'text' | 'url';
  addLabel: string;
  placeholder?: string;
  emptyHint: string;
  /** Per-item error messages keyed by index (from server 422 details). */
  itemErrors?: Record<number, string>;
}

export function ListEditor({
  items,
  onChange,
  variant = 'text',
  addLabel,
  placeholder,
  emptyHint,
  itemErrors,
}: ListEditorProps) {
  // Stable row ids so React keys survive edits/removals (never use array index).
  const idsRef = useRef<number[]>([]);
  const seqRef = useRef(0);
  while (idsRef.current.length < items.length) idsRef.current.push(++seqRef.current);
  if (idsRef.current.length > items.length) idsRef.current.length = items.length;

  function update(index: number, value: string) {
    const next = items.slice();
    next[index] = value;
    onChange(next);
  }
  function remove(index: number) {
    const next = items.slice();
    next.splice(index, 1);
    idsRef.current.splice(index, 1);
    onChange(next);
  }
  function add() {
    onChange([...items, '']);
  }

  return (
    <div className="list-editor">
      {items.length === 0 ? (
        <div className="list-editor__empty">{emptyHint}</div>
      ) : (
        items.map((value, index) => (
          <div className="list-editor__item" key={idsRef.current[index]}>
            <span className="list-editor__index" aria-hidden="true">
              {index + 1}
            </span>
            {variant === 'url' ? (
              <TextInput
                mono
                value={value}
                placeholder={placeholder}
                invalid={Boolean(itemErrors?.[index])}
                onChange={(e) => update(index, e.target.value)}
                aria-label={`${addLabel} ${index + 1}`}
              />
            ) : (
              <TextArea
                value={value}
                placeholder={placeholder}
                invalid={Boolean(itemErrors?.[index])}
                onChange={(e) => update(index, e.target.value)}
                aria-label={`${addLabel} ${index + 1}`}
                rows={2}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Remove item ${index + 1}`}
              onClick={() => remove(index)}
            >
              <IconTrash size={15} />
            </Button>
          </div>
        ))
      )}
      <div>
        <Button variant="secondary" size="sm" onClick={add} type="button">
          <IconPlus size={15} /> {addLabel}
        </Button>
      </div>
    </div>
  );
}
