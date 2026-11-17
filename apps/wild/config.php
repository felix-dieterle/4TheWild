<?php
/**
 * 4TheWild – Database Configuration
 *
 * Reads connection parameters from environment variables so that credentials
 * are never hard-coded in source control.  Set these variables in your PHP
 * environment (e.g. via a .env loader, Apache SetEnv, or php-fpm pool config):
 *
 *   DB_HOST      MySQL hostname     (default: localhost)
 *   DB_PORT      MySQL port         (default: 3306)
 *   DB_NAME      Database name      (default: 4thewild)
 *   DB_USER      MySQL username     (default: root)
 *   DB_PASS      MySQL password     (default: empty)
 *   DB_CHARSET   Connection charset (default: utf8mb4)
 *
 * Alternatively place a `config.local.php` next to this file (git-ignored) that
 * returns an array of overrides, e.g.
 *
 *   <?php return ['user' => 'wild4', 'pass' => '...', 'name' => '4thewild'];
 *
 * Values from config.local.php take precedence over environment variables.
 *
 * Returns a PDO instance with error mode set to EXCEPTION.
 */

declare(strict_types=1);

function db_connect(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $local = [];
    $localFile = __DIR__ . '/config.local.php';
    if (is_file($localFile)) {
        $loaded = require $localFile;
        if (is_array($loaded)) {
            $local = $loaded;
        }
    }

    $host    = $local['host']    ?? (getenv('DB_HOST')    ?: 'localhost');
    $port    = $local['port']    ?? (getenv('DB_PORT')    ?: '3306');
    $dbname  = $local['name']    ?? (getenv('DB_NAME')    ?: '4thewild');
    $user    = $local['user']    ?? (getenv('DB_USER')    ?: 'root');
    $pass    = $local['pass']    ?? (getenv('DB_PASS')    ?: '');
    $charset = $local['charset'] ?? (getenv('DB_CHARSET') ?: 'utf8mb4');

    $dsn = "mysql:host={$host};port={$port};dbname={$dbname};charset={$charset}";

    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    $pdo = new PDO($dsn, $user, $pass, $options);
    return $pdo;
}
