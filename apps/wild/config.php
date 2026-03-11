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
 * Returns a PDO instance with error mode set to EXCEPTION.
 */

declare(strict_types=1);

function db_connect(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $host    = getenv('DB_HOST')    ?: 'localhost';
    $port    = getenv('DB_PORT')    ?: '3306';
    $dbname  = getenv('DB_NAME')    ?: '4thewild';
    $user    = getenv('DB_USER')    ?: 'root';
    $pass    = getenv('DB_PASS')    ?: '';
    $charset = getenv('DB_CHARSET') ?: 'utf8mb4';

    $dsn = "mysql:host={$host};port={$port};dbname={$dbname};charset={$charset}";

    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    $pdo = new PDO($dsn, $user, $pass, $options);
    return $pdo;
}
