export const DATABASE_SCHEMA_VERSION = 2

export const DATABASE_MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE app_settings (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      active_canvas_id TEXT,
      active_planning_session_id TEXT,
      active_profile_id TEXT,
      agent_profile_id TEXT,
      agent_model TEXT,
      redis_snapshot_version TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;

    INSERT INTO app_settings (singleton_id, updated_at)
    VALUES (1, CURRENT_TIMESTAMP);

    CREATE TABLE canvases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      learning_goal TEXT,
      target_outcome TEXT,
      path_mode TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      parent_id TEXT,
      node_type TEXT NOT NULL,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      title TEXT NOT NULL,
      brief TEXT,
      expanded INTEGER NOT NULL,
      note TEXT NOT NULL,
      source_quote TEXT,
      branch_context TEXT,
      agent_opening_prompt TEXT,
      learning_status TEXT,
      knowledge_json TEXT,
      sort_order INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX nodes_canvas_order_idx ON nodes(canvas_id, sort_order);
    CREATE INDEX nodes_parent_idx ON nodes(parent_id);

    CREATE TABLE node_messages (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      generation_status TEXT,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (node_id, message_id)
    ) STRICT;

    CREATE INDEX node_messages_order_idx ON node_messages(node_id, sort_order);

    CREATE TABLE edges (
      canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (canvas_id, edge_id)
    ) STRICT;

    CREATE INDEX edges_order_idx ON edges(canvas_id, sort_order);

    CREATE TABLE agent_planning_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      input TEXT NOT NULL,
      plan_json TEXT,
      pending_plan_json TEXT,
      pending_plan_kind TEXT,
      ready_to_initialize INTEGER NOT NULL,
      missing_information_json TEXT NOT NULL,
      ready_to_adopt INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      adopted_canvas_id TEXT,
      sort_order INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE agent_planning_messages (
      session_id TEXT NOT NULL REFERENCES agent_planning_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (session_id, sort_order)
    ) STRICT;

    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      canvas_title TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX agent_sessions_canvas_idx ON agent_sessions(canvas_id, updated_at DESC);

    CREATE TABLE agent_session_messages (
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (session_id, sort_order)
    ) STRICT;

    CREATE TABLE agent_reviewed_operations (
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      review_id TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      review_status TEXT NOT NULL,
      result TEXT,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (session_id, review_id)
    ) STRICT;
  `,
}, {
  version: 2,
  sql: `
    ALTER TABLE app_settings ADD COLUMN workspace_version INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE nodes_v2 (
      canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      parent_id TEXT,
      node_type TEXT NOT NULL,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      title TEXT NOT NULL,
      brief TEXT,
      expanded INTEGER NOT NULL,
      note TEXT NOT NULL,
      source_quote TEXT,
      branch_context TEXT,
      agent_opening_prompt TEXT,
      learning_status TEXT,
      knowledge_json TEXT,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (canvas_id, id)
    ) STRICT;

    INSERT INTO nodes_v2 (
      canvas_id, id, parent_id, node_type, position_x, position_y, title, brief, expanded, note,
      source_quote, branch_context, agent_opening_prompt, learning_status, knowledge_json, sort_order
    )
    SELECT
      canvas_id, id, parent_id, node_type, position_x, position_y, title, brief, expanded, note,
      source_quote, branch_context, agent_opening_prompt, learning_status, knowledge_json, sort_order
    FROM nodes;

    CREATE TABLE node_messages_v2 (
      canvas_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      generation_status TEXT,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (canvas_id, node_id, message_id),
      FOREIGN KEY (canvas_id, node_id) REFERENCES nodes_v2(canvas_id, id) ON DELETE CASCADE
    ) STRICT;

    INSERT INTO node_messages_v2 (canvas_id, node_id, message_id, role, content, generation_status, sort_order)
    SELECT nodes.canvas_id, node_messages.node_id, node_messages.message_id, node_messages.role,
      node_messages.content, node_messages.generation_status, node_messages.sort_order
    FROM node_messages
    JOIN nodes ON nodes.id = node_messages.node_id;

    CREATE TABLE edges_v2 (
      canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (canvas_id, edge_id)
    ) STRICT;

    INSERT INTO edges_v2 (canvas_id, edge_id, source_id, target_id, sort_order)
    SELECT canvas_id, edge_id, source_id, target_id, sort_order FROM edges;

    DROP TABLE node_messages;
    DROP TABLE edges;
    DROP TABLE nodes;
    ALTER TABLE nodes_v2 RENAME TO nodes;
    ALTER TABLE node_messages_v2 RENAME TO node_messages;
    ALTER TABLE edges_v2 RENAME TO edges;
    CREATE INDEX nodes_canvas_order_idx ON nodes(canvas_id, sort_order);
    CREATE INDEX nodes_parent_idx ON nodes(canvas_id, parent_id);
    CREATE INDEX node_messages_order_idx ON node_messages(canvas_id, node_id, sort_order);
    CREATE INDEX edges_order_idx ON edges(canvas_id, sort_order);

    CREATE TABLE agent_planning_sessions_v2 (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      input TEXT NOT NULL,
      plan_json TEXT,
      pending_plan_json TEXT,
      pending_plan_kind TEXT,
      ready_to_initialize INTEGER NOT NULL,
      missing_information_json TEXT NOT NULL,
      ready_to_adopt INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      adopted_canvas_id TEXT REFERENCES canvases(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL
    ) STRICT;

    INSERT INTO agent_planning_sessions_v2 (
      id, title, input, plan_json, pending_plan_json, pending_plan_kind, ready_to_initialize,
      missing_information_json, ready_to_adopt, created_at, updated_at, adopted_canvas_id, sort_order
    )
    SELECT id, title, input, plan_json, pending_plan_json, pending_plan_kind, ready_to_initialize,
      missing_information_json, ready_to_adopt, created_at, updated_at,
      CASE WHEN adopted_canvas_id IN (SELECT id FROM canvases) THEN adopted_canvas_id ELSE NULL END,
      sort_order
    FROM agent_planning_sessions;

    CREATE TABLE agent_planning_messages_v2 (
      session_id TEXT NOT NULL REFERENCES agent_planning_sessions_v2(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (session_id, sort_order)
    ) STRICT;

    INSERT INTO agent_planning_messages_v2 (session_id, role, content, sort_order)
    SELECT session_id, role, content, sort_order FROM agent_planning_messages;

    DROP TABLE agent_planning_messages;
    DROP TABLE agent_planning_sessions;
    ALTER TABLE agent_planning_sessions_v2 RENAME TO agent_planning_sessions;
    ALTER TABLE agent_planning_messages_v2 RENAME TO agent_planning_messages;

    CREATE TABLE agent_sessions_v2 (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      canvas_title TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    ) STRICT;

    INSERT INTO agent_sessions_v2 (id, canvas_id, canvas_title, title, created_at, updated_at, sort_order)
    SELECT id, canvas_id, canvas_title, title, created_at, updated_at, sort_order
    FROM agent_sessions
    WHERE canvas_id IN (SELECT id FROM canvases);

    CREATE TABLE agent_session_messages_v2 (
      session_id TEXT NOT NULL REFERENCES agent_sessions_v2(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (session_id, sort_order)
    ) STRICT;

    INSERT INTO agent_session_messages_v2 (session_id, role, content, sort_order)
    SELECT agent_session_messages.session_id, agent_session_messages.role,
      agent_session_messages.content, agent_session_messages.sort_order
    FROM agent_session_messages
    JOIN agent_sessions_v2 ON agent_sessions_v2.id = agent_session_messages.session_id;

    CREATE TABLE agent_reviewed_operations_v2 (
      session_id TEXT NOT NULL REFERENCES agent_sessions_v2(id) ON DELETE CASCADE,
      review_id TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      review_status TEXT NOT NULL,
      result TEXT,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (session_id, review_id)
    ) STRICT;

    INSERT INTO agent_reviewed_operations_v2 (
      session_id, review_id, operation_json, expected_revision, review_status, result, sort_order
    )
    SELECT agent_reviewed_operations.session_id, agent_reviewed_operations.review_id,
      agent_reviewed_operations.operation_json, agent_reviewed_operations.expected_revision,
      agent_reviewed_operations.review_status, agent_reviewed_operations.result,
      agent_reviewed_operations.sort_order
    FROM agent_reviewed_operations
    JOIN agent_sessions_v2 ON agent_sessions_v2.id = agent_reviewed_operations.session_id;

    DROP TABLE agent_session_messages;
    DROP TABLE agent_reviewed_operations;
    DROP TABLE agent_sessions;
    ALTER TABLE agent_sessions_v2 RENAME TO agent_sessions;
    ALTER TABLE agent_session_messages_v2 RENAME TO agent_session_messages;
    ALTER TABLE agent_reviewed_operations_v2 RENAME TO agent_reviewed_operations;
    CREATE INDEX agent_sessions_canvas_idx ON agent_sessions(canvas_id, updated_at DESC);
  `,
}] as const
