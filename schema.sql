DROP TABLE IF EXISTS chat_history;
CREATE TABLE chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT,
    role TEXT, -- 'user' or 'assistant'
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);