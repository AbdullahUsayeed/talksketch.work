import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

const TABS = [
  ['notes', 'Notes'],
  ['actions', 'Actions'],
  ['board', 'Board'],
];

const COLUMNS = {
  agenda: [80, -220],
  point: [80, 120],
  decision: [700, 120],
  risk: [1320, 120],
  action: [1940, 120],
};

const COLORS = {
  agenda: '#1971c2',
  point: '#1e1e1e',
  decision: '#2f9e44',
  risk: '#e03131',
  action: '#f08c00',
};

export default function App() {
  const [tab, setTab] = useState(window.location.hash === '#board' ? 'board' : 'notes');
  const [api, setApi] = useState(null);
  const [state, setState] = useState({ notes: [], actions: [], suggestions: [], summary: '' });
  const cursors = useRef({});

  const applyBoard = useCallback(
    (ops) => {
      if (!api || !Array.isArray(ops) || ops.length === 0) return;
      const converted = convertToExcalidrawElements(
        ops.map((op) => {
          const [x, base] = COLUMNS[op.kind] ?? COLUMNS.point;
          const y = cursors.current[op.kind] ?? base;
          cursors.current[op.kind] = y + 120;
          return {
            type: 'text',
            x,
            y,
            width: 520,
            height: 100,
            text: String(op.text).slice(0, 160),
            fontSize: 18,
            strokeColor: COLORS[op.kind] ?? COLORS.point,
          };
        }),
      );
      api.updateScene({ elements: [...api.getSceneElements(), ...converted] });
      api.scrollToContent(converted[0], { fitToContent: true, animate: true });
    },
    [api],
  );

  useEffect(() => {
    if (tab === 'board' && api) setTimeout(() => api.refresh(), 60);
  }, [tab, api]);

  useEffect(() => {
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.source !== 'talksketch') return;
      if (data.type === 'state') {
        setState({
          notes: data.notes ?? [],
          actions: data.actions ?? [],
          suggestions: data.suggestions ?? [],
          summary: data.summary ?? '',
        });
      }
      if (data.type === 'board') {
        if (data.clear) {
          cursors.current = {};
          api?.updateScene({ elements: [] });
        } else {
          applyBoard(data.ops);
        }
      }
      if (data.type === 'tab') setTab(data.tab);
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ source: 'talksketch-panel', type: 'ready' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [applyBoard, api]);

  return (
    <div className="panel">
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
            {id === 'notes' && state.notes.length > 0 ? <span>{state.notes.length}</span> : null}
            {id === 'actions' && state.actions.length > 0 ? <span>{state.actions.length}</span> : null}
          </button>
        ))}
      </div>

      <div className="content">
        <div className={`board ${tab === 'board' ? 'active' : ''}`}>
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={{ appState: { viewBackgroundColor: '#f6f2e9' } }}
          />
        </div>

        <div className={`list ${tab === 'notes' ? 'active' : ''}`}>
          {state.summary ? <p className="summary">{state.summary}</p> : null}
          {state.notes.length === 0 ? (
            <p className="empty">Notes appear here once you start listening.</p>
          ) : (
            state.notes.map((note, index) => (
              <div className="item" key={index}>
                <p>{note.content}</p>
              </div>
            ))
          )}
        </div>

        <div className={`list ${tab === 'actions' ? 'active' : ''}`}>
          <h3>Action items</h3>
          {state.actions.length === 0 ? (
            <p className="empty">No action items yet.</p>
          ) : (
            state.actions.map((action, index) => (
              <div className="item action" key={index}>
                <p>{action.task}</p>
                <span>{[action.assignee, action.deadline].filter(Boolean).join(' · ')}</span>
              </div>
            ))
          )}
          <h3>Suggestions</h3>
          {state.suggestions.length === 0 ? (
            <p className="empty">No suggestions yet.</p>
          ) : (
            state.suggestions.map((suggestion, index) => (
              <div className="item suggestion" key={index}>
                <b>{suggestion.topic}</b>
                <p>{suggestion.rationale}</p>
                <p>{suggestion.suggestion}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
