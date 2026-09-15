// The boundary between chat and app: 6 px, draggable, and focusable.
//
// It is absolutely positioned over the grid line rather than living inside
// either pane, because a handle inside the chat pane is a handle that scrolls
// with it and clips at its overflow. The only thing it needs from the layout is
// where the line is, which the shell already computes.
//
// `role="separator"` with `aria-orientation="vertical"` and a `tabIndex` is the
// ARIA window-splitter pattern: it is a real widget, so the keyboard gets the
// same range the pointer does — arrows nudge, Home and End take the ends, and
// Enter is "put it back", which is the same thing double-click does.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { IRIS_MIN_WIDTH, irisMaxWidth } from '../model/store.js';

export interface PanelResizerProps {
  /** Distance from the shell's left edge to the grid line, in px. */
  left: number;
  /** The current chat width, which is what the separator's value reports. */
  width: number;
  workArea: number;
  /** Where the shell's left edge is, so a pointer x becomes a width. */
  originRef: { current: HTMLElement | null };
  onWidth: (width: number) => void;
  onReset: () => void;
  onDragging: (dragging: boolean) => void;
  label: string;
}

const STEP = 24;

export function PanelResizer({ left, width, workArea, originRef, onWidth, onReset, onDragging, label }: PanelResizerProps) {
  const dragging = useRef(false);
  const max = irisMaxWidth(workArea);

  const widthFrom = (clientX: number): number => {
    const origin = originRef.current?.getBoundingClientRect().left ?? 0;
    // The grid line sits at nav + width, so the width is everything between the
    // pointer and the end of the navigation — which is `left - width` wide.
    return clientX - origin - (left - width);
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    onDragging(false);
    document.body.classList.remove('is-resizing');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={IRIS_MIN_WIDTH}
      aria-valuemax={max}
      tabIndex={0}
      style={{ left: left - 3 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging.current = true;
        onDragging(true);
        // Not a style toggle for its own sake: without it a drag that leaves the
        // handle selects the transcript's text behind it, and the cursor flicks
        // back to the pane's own as soon as the pointer crosses the line.
        document.body.classList.add('is-resizing');
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        onWidth(widthFrom(event.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={() => {
        if (!dragging.current) return;
        dragging.current = false;
        onDragging(false);
        document.body.classList.remove('is-resizing');
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onWidth(width - STEP);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onWidth(width + STEP);
        } else if (event.key === 'Home') {
          event.preventDefault();
          onWidth(IRIS_MIN_WIDTH);
        } else if (event.key === 'End') {
          event.preventDefault();
          onWidth(max);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          onReset();
        }
      }}
    />
  );
}
