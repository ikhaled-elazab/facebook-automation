/*
 * BranchManager.tsx — manage the N targeting branches under one account (v2).
 *
 * A branch is one targeting context: which page it monitors, the DM identity, its
 * check cadence, its own daily cap (≤ the account ceiling), enabled flag, and its
 * content collections (comments / replies / dm_messages / groups). Every account
 * has ≥1 branch and exactly one default.
 *
 * Layout: a master list (left) of the account's branches + a detail editor
 * (right) for the selected branch. CRUD:
 *   - Add:      a new unsaved draft branch held locally until first save.
 *   - Edit:     loads the branch WITH children, edits, PATCHes.
 *   - Default:  set-default endpoint (server enforces exactly-one).
 *   - Delete:   blocked for the last branch and for the current default (must
 *               reassign default first) — with a clear, actionable message.
 *
 * State strategy: the list is the source of truth (api.branches.list, no
 * children); the detail form lazy-loads the selected branch's children on demand.
 * After any mutation we reload the list and re-render from the response.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/ApiError';
import { errorMessage } from '../lib/format';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { BranchEditorForm } from './BranchEditorForm';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHead,
  EmptyState,
  ErrorState,
  LoadingState,
} from './ui';
import { IconPlus, IconCheck, IconTrash, IconInbox } from './icons';
import type { Branch } from '../api/types';

interface BranchManagerProps {
  accountId: number;
  accountName: string;
}

/** The detail pane is editing either an existing branch (id) or a new draft. */
type Selection = { kind: 'existing'; id: number } | { kind: 'new' } | null;

export function BranchManager({ accountId, accountName }: BranchManagerProps) {
  const toast = useToast();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [pendingDelete, setPendingDelete] = useState<Branch | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(async (): Promise<Branch[]> => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await api.branches.list(accountId);
      setBranches(list);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) return []; // global redirect handles it
      setLoadError(errorMessage(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Auto-select the default (or first) branch once the list loads and nothing is
  // selected — so the operator always sees a branch rather than an empty pane.
  useEffect(() => {
    if (selection !== null || branches.length === 0) return;
    const target = branches.find((b) => b.is_default) ?? branches[0];
    setSelection({ kind: 'existing', id: target.id });
  }, [branches, selection]);

  const isLastBranch = branches.length <= 1;

  function startCreate() {
    setSelection({ kind: 'new' });
  }

  async function handleSaved(saved: Branch, wasCreate: boolean) {
    const list = await reload();
    // Select the saved branch (find by id in case ordering changed).
    const found = list.find((b) => b.id === saved.id);
    setSelection(found ? { kind: 'existing', id: found.id } : null);
    toast.success(
      wasCreate ? `Branch "${saved.name}" created.` : `Branch "${saved.name}" saved.`
    );
  }

  async function handleSetDefault(branch: Branch) {
    try {
      await api.branches.setDefault(accountId, branch.id);
      await reload();
      toast.success(`"${branch.name}" is now the default branch.`);
    } catch (err) {
      toast.error(`Could not set default: ${errorMessage(err)}`);
    }
  }

  function requestDelete(branch: Branch) {
    // Guard: never allow deleting the last branch or the current default. These
    // are also enforced server-side; we surface a clear message before the call.
    if (isLastBranch) {
      toast.error('Cannot delete the only branch. An account must have at least one branch.');
      return;
    }
    if (branch.is_default) {
      toast.error('Cannot delete the default branch. Set another branch as default first.');
      return;
    }
    setPendingDelete(branch);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.branches.remove(accountId, pendingDelete.id);
      const removedId = pendingDelete.id;
      toast.success(`Deleted branch "${pendingDelete.name}".`);
      setPendingDelete(null);
      const list = await reload();
      // If the deleted branch was selected, fall back to the default/first.
      if (selection?.kind === 'existing' && selection.id === removedId) {
        const next = list.find((b) => b.is_default) ?? list[0] ?? null;
        setSelection(next ? { kind: 'existing', id: next.id } : null);
      }
    } catch (err) {
      toast.error(`Could not delete branch: ${errorMessage(err)}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="Branches"
        description={
          loading
            ? 'Loading branches…'
            : `${branches.length} targeting ${branches.length === 1 ? 'branch' : 'branches'} for ${accountName}`
        }
        actions={
          <Button variant="primary" size="sm" onClick={startCreate} type="button">
            <IconPlus size={15} /> Add branch
          </Button>
        }
      />
      <CardBody flush>
        {loading ? (
          <div className="card__body">
            <LoadingState label="Loading branches…" />
          </div>
        ) : loadError ? (
          <div className="card__body">
            <ErrorState message={loadError} onRetry={() => void reload()} />
          </div>
        ) : branches.length === 0 && selection?.kind !== 'new' ? (
          <EmptyState
            icon={<IconInbox size={22} />}
            title="No branches yet"
            description="Add a branch to set the page this account targets and the content it uses. Every account needs at least one branch to run."
            action={
              <Button variant="primary" size="sm" onClick={startCreate} type="button">
                <IconPlus size={15} /> Add the first branch
              </Button>
            }
          />
        ) : (
          <div className="branch-layout">
            <BranchList
              branches={branches}
              selection={selection}
              isLastBranch={isLastBranch}
              onSelect={(id) => setSelection({ kind: 'existing', id })}
              onSetDefault={handleSetDefault}
              onDelete={requestDelete}
            />
            <div className="branch-detail">
              {selection === null ? (
                <div className="branch-detail__placeholder">
                  Select a branch to edit, or add a new one.
                </div>
              ) : (
                <BranchEditorForm
                  // Remount when the selection target changes so form state resets
                  // cleanly (and a new draft never inherits a prior branch's state).
                  key={selection.kind === 'new' ? 'new' : `branch-${selection.id}`}
                  accountId={accountId}
                  branchId={selection.kind === 'existing' ? selection.id : null}
                  isOnlyBranch={isLastBranch}
                  existingBranchCount={branches.length}
                  onSaved={handleSaved}
                  onCancelCreate={() => {
                    // Drop the draft; fall back to the default/first branch.
                    const next = branches.find((b) => b.is_default) ?? branches[0] ?? null;
                    setSelection(next ? { kind: 'existing', id: next.id } : null);
                  }}
                />
              )}
            </div>
          </div>
        )}
      </CardBody>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete branch?"
        destructive
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        body={
          <span>
            This permanently deletes the branch{' '}
            <strong className="mono">{pendingDelete?.name}</strong> and all its content
            (comments, replies, DM messages, groups). This cannot be undone.
          </span>
        }
      />
    </Card>
  );
}

// ── master list ──────────────────────────────────────────────────────────────

interface BranchListProps {
  branches: Branch[];
  selection: Selection;
  isLastBranch: boolean;
  onSelect: (id: number) => void;
  onSetDefault: (branch: Branch) => void;
  onDelete: (branch: Branch) => void;
}

function BranchList({
  branches,
  selection,
  isLastBranch,
  onSelect,
  onSetDefault,
  onDelete,
}: BranchListProps) {
  return (
    <ul className="branch-list" aria-label="Branches">
      {branches.map((branch) => {
        const selected = selection?.kind === 'existing' && selection.id === branch.id;
        return (
          <li key={branch.id} className={`branch-list__item${selected ? ' is-selected' : ''}`}>
            <button
              type="button"
              className="branch-list__select"
              aria-current={selected || undefined}
              onClick={() => onSelect(branch.id)}
            >
              <span className="branch-list__name">{branch.name}</span>
              <span className="branch-list__tags">
                {branch.is_default && (
                  <Badge tone="accent" dot>
                    Default
                  </Badge>
                )}
                {branch.enabled ? (
                  <Badge tone="ok">On</Badge>
                ) : (
                  <Badge tone="info">Off</Badge>
                )}
              </span>
            </button>
            <div className="branch-list__actions">
              {!branch.is_default && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Set "${branch.name}" as default`}
                  title="Set as default"
                  onClick={() => onSetDefault(branch)}
                >
                  <IconCheck size={15} />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Delete branch "${branch.name}"`}
                title={
                  isLastBranch
                    ? 'Cannot delete the only branch'
                    : branch.is_default
                      ? 'Set another branch as default first'
                      : 'Delete branch'
                }
                disabled={isLastBranch || branch.is_default}
                onClick={() => onDelete(branch)}
              >
                <IconTrash size={15} />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
