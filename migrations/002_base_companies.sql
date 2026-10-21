-- The two main companies of the group. Administrators can rename them,
-- change the order, deactivate them or add other companies in the admin panel.
INSERT OR IGNORE INTO companies (name, sort_order, active, created_at, updated_at)
VALUES
  ('Algoritmi',   10, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Green Spark', 20, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
