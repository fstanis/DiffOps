import {
  ChevronRight,
  ChevronDown,
  Eye,
  EyeOff,
  FileDiff,
  FolderOpen,
  Folder,
  FilePlus,
  FileX,
  FilePen,
  Search,
  MessageSquare,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react';
import { memo, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';

import { type DiffFile, type CommentThread } from '../../types/diff';
import { isSafariBrowser } from '../utils/browser';

import { Checkbox } from './Checkbox';

interface FileListProps {
  /** Every listed file, hidden ones included; hidden rows stay visible so they can be restored. */
  files: DiffFile[];
  onScrollToFile: (path: string) => void;
  onFileSelected?: () => void;
  comments: CommentThread[];
  reviewedFiles: Set<string>;
  onToggleReviewed: (path: string) => void;
  onToggleFolderReviewed: (path: string, reviewed: boolean) => void;
  /** Paths excluded from the diff pane and from every AI prompt. */
  hiddenFiles: Set<string>;
  onToggleHidden: (path: string) => void;
  selectedFileIndex: number | null;
  /** Renders the numbered flat narrated list instead of the directory tree. */
  isNarratedView?: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
  file?: DiffFile;
}

const TREE_ROW_PADDING_LEFT_PX = 16;
const TREE_ICON_SIZE_PX = 16;
const TREE_ROW_GAP_PX = 8;
const TREE_INDENT_STEP_PX = TREE_ICON_SIZE_PX + TREE_ROW_GAP_PX;

function getTreeRowPaddingLeft(depth: number): string {
  return `${depth * TREE_INDENT_STEP_PX + TREE_ROW_PADDING_LEFT_PX}px`;
}

function getAllDirectoryPaths(node: TreeNode): string[] {
  if (!node.isDirectory || !node.children) return [];
  const paths: string[] = [];
  if (node.path) paths.push(node.path);
  node.children.forEach((child) => {
    paths.push(...getAllDirectoryPaths(child));
  });
  return paths;
}

interface ReviewTally {
  reviewable: number;
  reviewed: number;
}

function getReviewedDirectoryPaths(
  node: TreeNode,
  reviewedFiles: Set<string>,
  hiddenFiles: Set<string>,
): Set<string> {
  const reviewedDirectoryPaths = new Set<string>();

  // Hidden files count for neither side of the tally: a folder is struck
  // through once everything still up for review in it has been reviewed, and a
  // folder with nothing left to review is never struck through at all.
  const visit = (currentNode: TreeNode): ReviewTally => {
    if (currentNode.file) {
      if (hiddenFiles.has(currentNode.file.path)) {
        return { reviewable: 0, reviewed: 0 };
      }
      return { reviewable: 1, reviewed: reviewedFiles.has(currentNode.file.path) ? 1 : 0 };
    }

    if (!currentNode.isDirectory || !currentNode.children) {
      return { reviewable: 0, reviewed: 0 };
    }

    const tally = currentNode.children.reduce<ReviewTally>(
      (totals, child) => {
        const childTally = visit(child);
        return {
          reviewable: totals.reviewable + childTally.reviewable,
          reviewed: totals.reviewed + childTally.reviewed,
        };
      },
      { reviewable: 0, reviewed: 0 },
    );

    if (currentNode.path && tally.reviewable > 0 && tally.reviewed === tally.reviewable) {
      reviewedDirectoryPaths.add(currentNode.path);
    }
    return tally;
  };

  visit(node);
  return reviewedDirectoryPaths;
}

function buildFileTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    isDirectory: true,
    children: [],
  };

  files.forEach((file) => {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const isLast = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join('/');

      if (!current.children) {
        current.children = [];
      }

      let child = current.children.find((c) => c.name === part && c.isDirectory === !isLast);

      if (!child) {
        child = {
          name: part,
          path: pathSoFar,
          isDirectory: !isLast,
          children: isLast ? undefined : [],
          file: isLast ? file : undefined,
        };
        current.children.push(child);
      }

      current = child;
    }
  });

  // Collapses single-child directory chains into one combined name.
  const collapseDirectories = (node: TreeNode): TreeNode => {
    if (!node.isDirectory || !node.children) {
      return node;
    }

    node.children = node.children.map(collapseDirectories);

    if (node.children.length === 1 && node.children[0]?.isDirectory && node.children[0]?.children) {
      const child = node.children[0];
      if (child) {
        // The root keeps the full path structure.
        if (!node.name) {
          return node;
        }
        return {
          ...node,
          name: `${node.name}/${child.name}`,
          path: child.path,
          children: child.children,
        };
      }
    }

    return node;
  };

  return collapseDirectories(root);
}

interface HideToggleProps {
  isHidden: boolean;
  onToggle: () => void;
}

/**
 * Per-file visibility switch: an open eye while the file takes part in the
 * review, a struck-through one once it is out of both the diff pane and the AI
 * prompts.
 */
function HideToggle({ isHidden, onToggle }: HideToggleProps) {
  const label = isHidden ? 'Show this file again' : 'Hide this file from the review and the AI';

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`shrink-0 rounded p-0.5 transition-colors hover:bg-github-bg-primary ${
        isHidden
          ? 'text-github-text-muted'
          : 'text-github-text-secondary opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
      }`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  );
}

export const FileList = memo(function FileList({
  files,
  onScrollToFile,
  onFileSelected,
  comments,
  reviewedFiles,
  onToggleReviewed,
  onToggleFolderReviewed,
  hiddenFiles,
  onToggleHidden,
  selectedFileIndex,
  isNarratedView = false,
}: FileListProps) {
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const shouldUseStickyDirectoryHeaders = useMemo(
    () => !isSafariBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent),
    [],
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const dirContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const stickyContainerStyle = {
    '--dir-row-height': 'calc(var(--spacing, 0.25rem) * 9)',
  } as CSSProperties;

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(getAllDirectoryPaths(fileTree)),
  );
  const [filterText, setFilterText] = useState('');

  const commentCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    comments.forEach((comment) => {
      counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
    });
    return counts;
  }, [comments]);

  // Hidden files are absent from the reviewed document, so the numbering the
  // caller's cursor indexes into skips them too.
  const reviewableFiles = useMemo(
    () => (hiddenFiles.size === 0 ? files : files.filter((file) => !hiddenFiles.has(file.path))),
    [files, hiddenFiles],
  );
  const fileIndexMap = useMemo(() => {
    const indices = new Map<string, number>();
    reviewableFiles.forEach((file, index) => {
      indices.set(file.path, index);
    });
    return indices;
  }, [reviewableFiles]);
  const diffTotals = useMemo(
    () =>
      reviewableFiles.reduce(
        (totals, file) => ({
          additions: totals.additions + file.additions,
          deletions: totals.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [reviewableFiles],
  );
  const hiddenCount = files.length - reviewableFiles.length;
  const reviewedDirectoryPaths = useMemo(
    () => getReviewedDirectoryPaths(fileTree, reviewedFiles, hiddenFiles),
    [fileTree, reviewedFiles, hiddenFiles],
  );

  const filteredFileTree = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();

    const filterTreeNode = (node: TreeNode): TreeNode | null => {
      if (!normalizedFilter) return node;

      if (node.isDirectory && node.children) {
        const filteredChildren = node.children
          .map((child) => filterTreeNode(child))
          .filter((child) => child !== null);

        if (filteredChildren.length > 0) {
          return { ...node, children: filteredChildren };
        }
        return null;
      } else if (node.file) {
        if (node.file.path.toLowerCase().includes(normalizedFilter)) {
          return node;
        }
        return null;
      }

      return null;
    };

    return (
      filterTreeNode(fileTree) || {
        ...fileTree,
        children: [],
      }
    );
  }, [fileTree, filterText]);

  const getFileIcon = (status: DiffFile['status']) => {
    switch (status) {
      case 'added':
        return <FilePlus size={16} className="text-github-accent" />;
      case 'deleted':
        return <FileX size={16} className="text-github-danger" />;
      case 'renamed':
        return <FilePen size={16} className="text-github-warning" />;
      default:
        return <FileDiff size={16} className="text-github-text-secondary" />;
    }
  };

  const toggleDirectory = (path: string) => {
    setExpandedDirs((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const allPaths = useMemo(() => getAllDirectoryPaths(fileTree), [fileTree]);
  const isAllExpanded = expandedDirs.size === allPaths.length && allPaths.length > 0;

  const toggleAllDirectories = () => {
    if (isAllExpanded) {
      setExpandedDirs(new Set());
    } else {
      setExpandedDirs(new Set(allPaths));
    }
  };

  const handleDirectoryClick = (event: MouseEvent<HTMLDivElement>, path: string) => {
    if (!shouldUseStickyDirectoryHeaders) {
      toggleDirectory(path);
      return;
    }

    const container = scrollContainerRef.current;
    const row = event.currentTarget;

    if (!container) {
      toggleDirectory(path);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const topOffset = Number.parseFloat(getComputedStyle(row).top || '0');
    const relativeTop = rowRect.top - containerRect.top;
    const isSticky = relativeTop <= topOffset + 1;

    if (isSticky) {
      const wrapper = dirContainerRefs.current.get(path);
      const firstChild = wrapper?.querySelector<HTMLElement>(
        '[data-tree-row="true"]:not([data-dir-header="true"])',
      );
      const rowHeight = row.getBoundingClientRect().height || 0;
      const target = firstChild ?? row;
      const depthValue = Number.parseInt(target.dataset.depth || row.dataset.depth || '0', 10);
      const stackedOffset = rowHeight * depthValue;
      const targetScrollTop = Math.max(0, target.offsetTop - stackedOffset);

      if (Math.abs(container.scrollTop - targetScrollTop) <= 1) {
        toggleDirectory(path);
        return;
      }

      container.scrollTo({ top: targetScrollTop });
      return;
    }

    toggleDirectory(path);
  };

  const renderTreeNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    if (node.isDirectory && node.children) {
      const isExpanded = expandedDirs.has(node.path);
      const isReviewed = reviewedDirectoryPaths.has(node.path);

      return (
        <div
          key={node.path}
          data-dir-container={node.path || undefined}
          ref={(el) => {
            if (!node.path) return;
            if (el) {
              dirContainerRefs.current.set(node.path, el);
            } else {
              dirContainerRefs.current.delete(node.path);
            }
          }}
        >
          {node.name && (
            <div
              className={`${shouldUseStickyDirectoryHeaders ? 'sticky ' : ''}group flex h-9 items-center gap-2 bg-github-bg-secondary px-4 hover:bg-github-bg-tertiary cursor-pointer ${
                isReviewed ? 'opacity-70' : ''
              }`}
              data-dir-header="true"
              data-tree-row="true"
              data-depth={depth}
              style={{
                paddingLeft: getTreeRowPaddingLeft(depth),
                top: shouldUseStickyDirectoryHeaders
                  ? `calc(${depth} * var(--dir-row-height))`
                  : undefined,
                zIndex: shouldUseStickyDirectoryHeaders ? 1000 - depth : undefined,
              }}
              onClick={(event) => handleDirectoryClick(event, node.path)}
            >
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="flex items-center group-hover:hidden">
                {isExpanded ? (
                  <FolderOpen size={16} className="text-github-text-secondary" />
                ) : (
                  <Folder size={16} className="text-github-text-secondary" />
                )}
              </span>
              <span className="hidden items-center pl-[2px] group-hover:flex">
                <Checkbox
                  checked={isReviewed}
                  onChange={() => {
                    onToggleFolderReviewed(node.path, !isReviewed);
                  }}
                  title={
                    isReviewed ? 'Mark all files as not reviewed' : 'Mark all files as reviewed'
                  }
                  className="z-10"
                />
              </span>
              <span
                className={`text-sm text-github-text-primary font-medium flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${
                  isReviewed ? 'line-through text-github-text-muted' : ''
                }`}
                title={node.name}
              >
                {node.name}
              </span>
            </div>
          )}
          {(isExpanded || !node.name) &&
            node.children.map((child) => renderTreeNode(child, node.name ? depth + 1 : depth))}
        </div>
      );
    } else if (node.file) {
      const file = node.file;
      const commentCount = commentCountMap.get(file.path) ?? 0;
      const isReviewed = reviewedFiles.has(file.path);
      const isHidden = hiddenFiles.has(file.path);
      const fileIndex = fileIndexMap.get(file.path) ?? -1;
      const isSelected = selectedFileIndex !== null && selectedFileIndex === fileIndex;

      return (
        <div
          key={`file:${file.path}`}
          className={`group flex items-center gap-2 px-4 py-2 hover:bg-github-bg-tertiary transition-colors ${
            isHidden ? 'cursor-default' : 'cursor-pointer'
          } ${isReviewed || isHidden ? 'opacity-70' : ''} ${
            isSelected ? 'bg-github-bg-tertiary' : ''
          }`}
          data-file-row="true"
          data-tree-row="true"
          data-depth={depth}
          data-file-hidden={isHidden ? 'true' : undefined}
          style={{ paddingLeft: getTreeRowPaddingLeft(depth) }}
          onClick={() => {
            if (isHidden) return;
            onScrollToFile(file.path);
            onFileSelected?.();
          }}
        >
          <Checkbox
            checked={isReviewed}
            onChange={() => {
              onToggleReviewed(file.path);
            }}
            title={isReviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
            className="z-10"
          />
          {getFileIcon(node.file.status)}
          <span
            className={`text-sm text-github-text-primary flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${
              isReviewed ? 'line-through text-github-text-muted' : ''
            } ${isHidden ? 'italic text-github-text-muted' : ''}`}
            title={node.file.path}
          >
            {node.name}
          </span>
          {commentCount > 0 && (
            <span className="text-github-warning text-sm font-medium ml-auto flex items-center gap-1">
              <MessageSquare size={14} />
              {commentCount}
            </span>
          )}
          <HideToggle
            isHidden={isHidden}
            onToggle={() => {
              onToggleHidden(file.path);
            }}
          />
        </div>
      );
    }

    return null;
  };

  const renderNarratedRow = (file: DiffFile): React.ReactNode => {
    const commentCount = commentCountMap.get(file.path) ?? 0;
    const isReviewed = reviewedFiles.has(file.path);
    const isHidden = hiddenFiles.has(file.path);
    const fileIndex = fileIndexMap.get(file.path) ?? -1;
    const isSelected = selectedFileIndex !== null && selectedFileIndex === fileIndex;
    const separatorIndex = file.path.lastIndexOf('/');
    const directory = separatorIndex === -1 ? '' : `${file.path.slice(0, separatorIndex + 1)}`;
    const name = separatorIndex === -1 ? file.path : file.path.slice(separatorIndex + 1);

    return (
      <div
        key={`file:${file.path}`}
        className={`group flex items-center gap-2 px-4 py-2 hover:bg-github-bg-tertiary transition-colors ${
          isHidden ? 'cursor-default' : 'cursor-pointer'
        } ${isReviewed || isHidden ? 'opacity-70' : ''} ${
          isSelected ? 'bg-github-bg-tertiary' : ''
        }`}
        data-file-row="true"
        data-tree-row="true"
        data-depth={0}
        data-file-hidden={isHidden ? 'true' : undefined}
        onClick={() => {
          if (isHidden) return;
          onScrollToFile(file.path);
          onFileSelected?.();
        }}
      >
        <span className="w-6 shrink-0 text-right text-xs text-github-text-muted select-none">
          {isHidden ? '–' : fileIndex + 1}
        </span>
        <Checkbox
          checked={isReviewed}
          onChange={() => {
            onToggleReviewed(file.path);
          }}
          title={isReviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
          className="z-10"
        />
        {getFileIcon(file.status)}
        <span
          className={`text-sm text-github-text-primary flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${
            isReviewed ? 'line-through text-github-text-muted' : ''
          } ${isHidden ? 'italic text-github-text-muted' : ''}`}
          title={file.path}
        >
          {directory && <span className="text-github-text-muted">{directory}</span>}
          <span>{name}</span>
        </span>
        {commentCount > 0 && (
          <span className="text-github-warning text-sm font-medium ml-auto flex items-center gap-1">
            <MessageSquare size={14} />
            {commentCount}
          </span>
        )}
        <HideToggle
          isHidden={isHidden}
          onToggle={() => {
            onToggleHidden(file.path);
          }}
        />
      </div>
    );
  };

  const filteredNarratedFiles = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();
    if (!normalizedFilter) {
      return files;
    }
    return files.filter((file) => file.path.toLowerCase().includes(normalizedFilter));
  }, [files, filterText]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-github-border bg-github-bg-tertiary">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 mb-3">
          <h3 className="text-sm font-semibold text-github-text-primary m-0 flex items-baseline gap-1.5 whitespace-nowrap">
            <span>Files changed ({reviewableFiles.length})</span>
            {hiddenCount > 0 && (
              <span className="text-xs font-normal text-github-text-muted">
                {hiddenCount} hidden
              </span>
            )}
          </h3>
          <div className="ml-auto flex items-center gap-2">
            <span
              className="inline-flex gap-1 text-right text-xs font-medium whitespace-nowrap"
              title="Total additions and deletions"
              aria-label={`${diffTotals.additions} additions and ${diffTotals.deletions} deletions`}
            >
              <span className="text-github-accent">+{diffTotals.additions}</span>
              <span className="text-github-danger">-{diffTotals.deletions}</span>
            </span>
            {!isNarratedView && (
              <button
                onClick={toggleAllDirectories}
                className="p-1 hover:bg-github-bg-primary rounded transition-colors"
                title={isAllExpanded ? 'Collapse all' : 'Expand all'}
              >
                {isAllExpanded ? (
                  <ChevronsDownUp size={16} className="text-github-text-secondary" />
                ) : (
                  <ChevronsUpDown size={16} className="text-github-text-secondary" />
                )}
              </button>
            )}
          </div>
        </div>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 transform -translate-y-1/2 text-github-text-muted"
          />
          <input
            type="text"
            placeholder="Filter files..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-github-bg-primary border border-github-border rounded-md focus:outline-none focus:border-github-accent text-github-text-primary placeholder-github-text-muted"
          />
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto relative z-0"
        style={stickyContainerStyle}
        ref={scrollContainerRef}
      >
        {isNarratedView
          ? filteredNarratedFiles.map((file) => renderNarratedRow(file))
          : filteredFileTree.children?.map((child) => renderTreeNode(child))}
      </div>
    </div>
  );
});
