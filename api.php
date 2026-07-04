<?php
/*
 * api.php — Stackrack
 * Must be served through XAMPP (http://localhost/...), not opened as file://
 */

// ---- Config -------------------------------------------------------
define('DB_HOST', '127.0.0.1');
define('DB_USER', 'root');
define('DB_PASS', '');
// -------------------------------------------------------------------

session_start();
header('Content-Type: application/json');

// Allow same-origin requests from XAMPP localhost only
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ['http://localhost', 'http://127.0.0.1'])) {
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Allow-Headers: Content-Type');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// ---- DB connection ------------------------------------------------
function pdo(string $dbName): PDO {
    static $cache = [];
    if (!isset($cache[$dbName])) {
        $cache[$dbName] = new PDO(
            'mysql:host=' . DB_HOST . ';dbname=' . $dbName . ';charset=utf8mb4',
            DB_USER, DB_PASS,
            [PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
             PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
    }
    return $cache[$dbName];
}

// ---- Helpers -------------------------------------------------------
function ok(array $data = [])              { echo json_encode(['ok' => true] + $data); exit; }
function err(string $msg, int $code = 400) { http_response_code($code); echo json_encode(['error' => $msg]); exit; }

// ---- Session / user ------------------------------------------------
function getOrCreateUser(): string {
    if (empty($_SESSION['uid'])) {
        $_SESSION['uid'] = bin2hex(random_bytes(32));
    }
    $sid = $_SESSION['uid'];
    try {
        pdo('user')->prepare(
            'INSERT INTO users (session_id) VALUES (?)
             ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP'
        )->execute([$sid]);
    } catch (PDOException $e) {
        err('User DB error: ' . $e->getMessage(), 500);
    }
    return $sid;
}

// ---- Logging (non-fatal) ------------------------------------------
function log_action(string $sid, string $action, ?string $budgetId, array $meta = []): void {
    try {
        pdo('logs')->prepare(
            'INSERT INTO activity (session_id, action, budget_id, meta) VALUES (?, ?, ?, ?)'
        )->execute([$sid, $action, $budgetId, $meta ? json_encode($meta) : null]);
    } catch (Exception $e) {
        error_log('Stackrack log_action failed: ' . $e->getMessage());
    }
}

// ---- Backup on delete ---------------------------------------------
function backup_budget(string $budgetId, string $sid): void {
    try {
        $bdb = pdo('budget');
        $s   = $bdb->prepare('SELECT * FROM budgets WHERE id = ? AND session_id = ?');
        $s->execute([$budgetId, $sid]);
        $budget = $s->fetch();
        if (!$budget) return;

        $sh = $bdb->prepare('SELECT amount, created_at FROM spend_history WHERE budget_id = ? ORDER BY created_at ASC');
        $sh->execute([$budgetId]);

        pdo('backup')->prepare(
            'INSERT INTO deleted_budgets
             (original_id, session_id, name, `limit`, date_label, checked, spend_history)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $budget['id'], $sid, $budget['name'], $budget['limit'],
            $budget['date_label'], $budget['checked'],
            json_encode($sh->fetchAll())
        ]);
    } catch (Exception $e) {
        error_log('Stackrack backup_budget failed: ' . $e->getMessage());
    }
}

// ---- Ownership check ----------------------------------------------
function owns(string $budgetId, string $sid): bool {
    $s = pdo('budget')->prepare('SELECT 1 FROM budgets WHERE id = ? AND session_id = ?');
    $s->execute([$budgetId, $sid]);
    return (bool)$s->fetch();
}

// ---- Bootstrap ----------------------------------------------------
$SID = getOrCreateUser();

$method = $_SERVER['REQUEST_METHOD'];

// ==================================================================
// GET — all budgets + spend history for this session
// ==================================================================
if ($method === 'GET') {
    try {
        $bdb = pdo('budget');
        $bs  = $bdb->prepare(
            'SELECT id, name, `limit`, date_label, checked
             FROM budgets WHERE session_id = ? ORDER BY created_at ASC'
        );
        $bs->execute([$SID]);
        $rows = $bs->fetchAll();

        if (!$rows) ok(['budgets' => []]);

        $ids          = array_column($rows, 'id');
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $sp           = $bdb->prepare(
            "SELECT budget_id, amount, created_at
             FROM spend_history WHERE budget_id IN ($placeholders) ORDER BY created_at ASC"
        );
        $sp->execute($ids);

        $grouped = [];
        foreach ($sp->fetchAll() as $row) {
            $grouped[$row['budget_id']][] = [
                'amount'    => (float)$row['amount'],
                'timestamp' => strtotime($row['created_at']) * 1000
            ];
        }

        ok(['budgets' => array_map(fn($b) => [
            'id'           => $b['id'],
            'name'         => $b['name'],
            'limit'        => (float)$b['limit'],
            'date_label'   => $b['date_label'],
            'checked'      => (bool)$b['checked'],
            'spendHistory' => $grouped[$b['id']] ?? []
        ], $rows)]);

    } catch (PDOException $e) {
        err('GET failed: ' . $e->getMessage(), 500);
    }
}

// ==================================================================
// POST — action routing
// ==================================================================
if ($method === 'POST') {
    $body   = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) err('Invalid JSON body');
    $action = $body['action'] ?? '';

    // ---- add_budget -----------------------------------------------
    if ($action === 'add_budget') {
        $name  = trim((string)($body['name']  ?? ''));
        $limit = (float)($body['limit'] ?? 0);
        $date  = isset($body['date']) && $body['date'] !== null ? trim((string)$body['date']) : null;

        if ($name === '')  err('name is required');
        if ($limit <= 0)   err('limit must be greater than 0');

        try {
            $id = '_' . bin2hex(random_bytes(6));
            pdo('budget')->prepare(
                'INSERT INTO budgets (id, session_id, name, `limit`, date_label) VALUES (?, ?, ?, ?, ?)'
            )->execute([$id, $SID, $name, $limit, $date ?: null]);

            log_action($SID, 'add_budget', $id, ['name' => $name, 'limit' => $limit]);
            ok(['id' => $id]);
        } catch (PDOException $e) {
            err('add_budget failed: ' . $e->getMessage(), 500);
        }
    }

    // ---- add_spend ------------------------------------------------
    if ($action === 'add_spend') {
        $budgetId = trim((string)($body['budget_id'] ?? ''));
        $amount   = (float)($body['amount'] ?? 0);

        if ($budgetId === '') err('budget_id is required');
        if ($amount   <= 0)  err('amount must be greater than 0');

        try {
            if (!owns($budgetId, $SID)) err('budget not found', 404);

            pdo('budget')->prepare(
                'INSERT INTO spend_history (budget_id, amount) VALUES (?, ?)'
            )->execute([$budgetId, $amount]);

            log_action($SID, 'add_spend', $budgetId, ['amount' => $amount]);
            ok();
        } catch (PDOException $e) {
            err('add_spend failed: ' . $e->getMessage(), 500);
        }
    }

    // ---- remove_budget --------------------------------------------
    if ($action === 'remove_budget') {
        $budgetId = trim((string)($body['budget_id'] ?? ''));
        if ($budgetId === '') err('budget_id is required');

        try {
            if (!owns($budgetId, $SID)) err('budget not found', 404);

            backup_budget($budgetId, $SID);
            pdo('budget')->prepare('DELETE FROM budgets WHERE id = ?')->execute([$budgetId]);

            log_action($SID, 'remove_budget', $budgetId);
            ok();
        } catch (PDOException $e) {
            err('remove_budget failed: ' . $e->getMessage(), 500);
        }
    }

    // ---- set_checked ----------------------------------------------
    if ($action === 'set_checked') {
        $budgetId = trim((string)($body['budget_id'] ?? ''));
        $checked  = (int)(bool)($body['checked'] ?? false);
        if ($budgetId === '') err('budget_id is required');

        try {
            if (!owns($budgetId, $SID)) err('budget not found', 404);

            pdo('budget')->prepare(
                'UPDATE budgets SET checked = ? WHERE id = ?'
            )->execute([$checked, $budgetId]);

            log_action($SID, 'set_checked', $budgetId, ['checked' => (bool)$checked]);
            ok();
        } catch (PDOException $e) {
            err('set_checked failed: ' . $e->getMessage(), 500);
        }
    }

    err('unknown action');
}

err('method not allowed', 405);