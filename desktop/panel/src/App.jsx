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

function Segments({ list }) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return <span className="seg">[{list.join(', ')}]</span>;
}

export default function App() {
  const [tab, setTab] = useState(window.location.hash === '#board' ? 'board' : 'notes');
  const [api, setApi] = useState(null);
  const [session, setSession] = useState({
    title: '',
    summary: '',
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    uncertain: [],
    coverage: null,
  });
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
        setSession(
          data.session ?? {
            title: '',
            summary: '',
            topics: [],
            decisions: [],
            action_items: [],
            open_questions: [],
            uncertain: [],
            coverage: null,
          },
        );
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
            {id === 'notes' &&
            session.topics.reduce((count, topic) => count + topic.points.length, 0) > 0 ? (
              <span>{session.topics.reduce((count, topic) => count + topic.points.length, 0)}</span>
            ) : null}
            {id === 'actions' && session.action_items.length > 0 ? (
              <span>{session.action_items.length}</span>
            ) : null}
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
          {session.coverage && session.coverage.windows > 1 ? (
            <div className="coverage">
              Final notes cover segments {session.coverage.from}–{session.coverage.to}, merged from{' '}
              {session.coverage.windows} windows.
              {session.coverage.dropped ? ' Some earlier segments were not included.' : ''}
            </div>
          ) : null}
          {session.title ? <h2 className="session-title">{session.title}</h2> : null}
          {session.summary ? <p className="summary">{session.summary}</p> : null}

          {session.topics.map((topic, topicIndex) => (
            <section className="topic" key={topicIndex}>
              <h3>{topic.heading}</h3>
              {topic.points.map((point, pointIndex) => (
                <div className="item" key={pointIndex}>
                  <p>
                    {point.text} <Segments list={point.segments} />
                  </p>
                </div>
              ))}
            </section>
          ))}

          {session.decisions.length > 0 ? (
            <>
              <h3>Decisions</h3>
              {session.decisions.map((decision, index) => (
                <div className="item decision" key={index}>
                  <p>
                    {decision.text} <Segments list={decision.segments} />
                  </p>
                </div>
              ))}
            </>
          ) : null}

          {session.open_questions.length > 0 ? (
            <>
              <h3>Open questions</h3>
              {session.open_questions.map((question, index) => (
                <div className="item question" key={index}>
                  <p>
                    {question.text} <Segments list={question.segments} />
                  </p>
                </div>
              ))}
            </>
          ) : null}

          {session.uncertain.length > 0 ? (
            <>
              <h3>Verify</h3>
              {session.uncertain.map((item, index) => (
                <div className="item uncertain" key={index}>
                  <p>
                    {item.text} <Segments list={item.segments} />
                  </p>
                </div>
              ))}
            </>
          ) : null}

          {!session.title &&
          !session.summary &&
          session.topics.length === 0 &&
          session.decisions.length === 0 &&
          session.open_questions.length === 0 &&
          session.uncertain.length === 0 ? (
            <p className="empty">Notes appear here once you start listening.</p>
          ) : null}
        </div>

        <div className={`list ${tab === 'actions' ? 'active' : ''}`}>
          <h3>Action items</h3>
          {session.action_items.length === 0 ? (
            <p className="empty">No action items yet.</p>
          ) : (
            session.action_items.map((action, index) => (
              <div className="item action" key={index}>
                <p>
                  {action.task} <Segments list={action.segments} />
                </p>
                <span>
                  {[action.owner, action.deadline].filter(Boolean).join(' · ') || 'No owner yet'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
