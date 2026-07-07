const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = crypto.randomBytes(32).toString('hex');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database using the native Node.js sqlite module
const db = new DatabaseSync('smartscan.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    category TEXT NOT NULL,
    image_url TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    cart TEXT NOT NULL,
    total_price INTEGER NOT NULL,
    status TEXT NOT NULL, -- PENDING, PAID, COMPLETED
    qr_token TEXT NOT NULL,
    audited_items TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Seed products if database is empty
const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;

if (productCount === 0) {
  const insertProduct = db.prepare('INSERT INTO products (name, price, category, image_url) VALUES (?, ?, ?, ?)');
  
  const seedProducts = [
    ['Maggi Noodles (Pack of 4)', 14, 'Snacks & Packaged Food', 'noodles'],
    ['Premium Almonds (250g)', 500, 'Dry Fruits & Nuts', 'almonds'],
    ['Cadbury Silk Chocolate', 100, 'Confectionery', 'chocolate'],
    ['Fortune Cooking Oil (1L)', 180, 'Grocery & Staples', 'oil'],
    ['Fresh Royal Gala Apples (1kg)', 150, 'Fruits & Vegetables', 'apples'],
    ['Organic Forest Honey (500g)', 250, 'Grocery & Staples', 'honey'],
    ['Coca-Cola Zero Sugar (300ml)', 40, 'Beverages', 'soda'],
    ['Colgate MaxFresh Gel (150g)', 95, 'Personal Care', 'toothpaste'],
  ];

  for (const prod of seedProducts) {
    insertProduct.run(prod[0], prod[1], prod[2], prod[3]);
  }
  console.log('Seeded database with test products.');
}

// Helper to generate dynamic secure QR token
function generateQRToken(transactionId) {
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(transactionId);
  const signature = hmac.digest('hex').substring(0, 16); // Shorten for QR density
  return `${transactionId}:${signature}`;
}

// Helper to verify QR token
function verifyQRToken(qrToken) {
  if (!qrToken || !qrToken.includes(':')) return null;
  const [transactionId, signature] = qrToken.split(':');
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(transactionId);
  const expectedSignature = hmac.digest('hex').substring(0, 16);
  if (signature === expectedSignature) {
    return transactionId;
  }
  return null;
}

// --- API ROUTES ---

// 1. Get Product Catalog
app.get('/api/products', (req, res) => {
  try {
    const products = db.prepare('SELECT * FROM products').all();
    res.json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. Checkout (Simulates successful payment, triggers audit selection)
app.post('/api/checkout', (req, res) => {
  try {
    const { cart } = req.body;
    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Cart is empty or invalid.' });
    }

    // Calculate total price based on backend validation (prevent front-end injection)
    let total = 0;
    const itemsWithDetails = [];

    const selectProd = db.prepare('SELECT * FROM products WHERE id = ?');

    for (const item of cart) {
      const dbItem = selectProd.get(item.id);
      if (!dbItem) {
        return res.status(400).json({ error: `Product with ID ${item.id} not found.` });
      }
      const qty = parseInt(item.quantity) || 1;
      total += dbItem.price * qty;
      itemsWithDetails.push({
        id: dbItem.id,
        name: dbItem.name,
        price: dbItem.price,
        quantity: qty
      });
    }

    // Generate transaction ID
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randStr = crypto.randomBytes(3).toString('hex').toUpperCase();
    const transactionId = `TX-${dateStr}-${randStr}`;

    // Select exactly 3 items for Physical Audit (Randomized Partial Audit)
    // If cart has <= 3 unique items, audit all of them.
    // If cart has > 3 unique items, pick 3 random unique items.
    const uniqueItems = [...itemsWithDetails];
    let auditedItems = [];

    if (uniqueItems.length <= 3) {
      auditedItems = uniqueItems.map(item => ({ id: item.id, name: item.name, quantity: item.quantity }));
    } else {
      // Shuffle list and slice 3
      const shuffled = [...uniqueItems].sort(() => 0.5 - Math.random());
      auditedItems = shuffled.slice(0, 3).map(item => ({ id: item.id, name: item.name, quantity: item.quantity }));
    }

    // Generate secure QR Token
    const qrToken = generateQRToken(transactionId);

    // Save to Database (starts as PAID since payment was completed on Shopper App)
    const insertTx = db.prepare(`
      INSERT INTO transactions (id, cart, total_price, status, qr_token, audited_items)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertTx.run(
      transactionId,
      JSON.stringify(itemsWithDetails),
      total,
      'PAID',
      qrToken,
      JSON.stringify(auditedItems)
    );

    res.status(201).json({
      transactionId,
      qrToken,
      total,
      cart: itemsWithDetails,
      auditedItems
    });

  } catch (error) {
    console.error('Error during checkout:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. Get Active Paid Transactions (for testing dropdown in Auditor UI)
app.get('/api/active-transactions', (req, res) => {
  try {
    const active = db.prepare("SELECT id, qr_token, total_price FROM transactions WHERE status = 'PAID' ORDER BY created_at DESC").all();
    res.json(active);
  } catch (error) {
    console.error('Error fetching active transactions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. Get Transaction Details for Audit via QR Token (scanned by Auditor)
app.get('/api/audit/:qrToken', (req, res) => {
  try {
    const { qrToken } = req.params;
    
    // Verify signature
    const transactionId = verifyQRToken(qrToken);
    if (!transactionId) {
      return res.status(400).json({ error: 'Invalid or tampered receipt QR code.' });
    }

    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    res.json({
      transactionId: tx.id,
      cart: JSON.parse(tx.cart),
      total: tx.total_price,
      status: tx.status,
      auditedItems: JSON.parse(tx.audited_items),
      createdAt: tx.created_at
    });

  } catch (error) {
    console.error('Error fetching audit:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 5. Approve Exit (updates status from PAID to COMPLETED)
app.post('/api/audit/:transactionId/approve', (req, res) => {
  try {
    const { transactionId } = req.params;
    
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    if (tx.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Transaction already completed.' });
    }

    const updateStatus = db.prepare('UPDATE transactions SET status = ? WHERE id = ?');
    updateStatus.run('COMPLETED', transactionId);

    res.json({ success: true, status: 'COMPLETED' });

  } catch (error) {
    console.error('Error approving exit:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 6. Poll Transaction Status (used by Shopper App to detect gate authorization)
app.get('/api/checkout/:transactionId/status', (req, res) => {
  try {
    const { transactionId } = req.params;
    const tx = db.prepare('SELECT status FROM transactions WHERE id = ?').get(transactionId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    res.json({ status: tx.status });
  } catch (error) {
    console.error('Error polling status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`SmartScan Go server listening at http://localhost:${PORT}`);
});
