// backend/index.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const DATA_PATH = path.join(__dirname, "data.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");

// ensure uploads folder exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// ensure data.json exists
if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, JSON.stringify({ products: [], orders: [] }, null, 2));

const app = express();
app.use(cors());
app.use(express.json());

// serve frontend static files if you prefer (optional)
app.use("/", express.static(path.join(__dirname, "..", "frontend")));

// serve uploaded images
app.use("/uploads", express.static(UPLOAD_DIR));

// multer setup for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniq = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${uniq}${ext}`);
  }
});
const upload = multer({ storage });

// --- helpers to read/write data.json synchronously (simple) ---
function readDB() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}
function writeDB(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}
function makeId(prefix = "") {
  return prefix + Date.now().toString(36) + Math.round(Math.random() * 1e6).toString(36);
}

// ---------- ROUTES ----------
// test route
app.get("/api/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

// GET all products (with optional search query)
app.get("/api/products", (req, res) => {
  const { q, category } = req.query;
  const db = readDB();
  let items = db.products || [];
  if (q) {
    const qq = q.toLowerCase();
    items = items.filter(p => p.name.toLowerCase().includes(qq) || (p.category || "").toLowerCase().includes(qq));
  }
  if (category) items = items.filter(p => (p.category || "").toLowerCase() === category.toLowerCase());
  res.json(items);
});

// GET product by id
app.get("/api/products/:id", (req, res) => {
  const db = readDB();
  const p = db.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found" });
  res.json(p);
});

// Admin: add product (multipart/form-data with image)
app.post("/api/admin/product", upload.single("image"), (req, res) => {
  try {
    const db = readDB();
    const { name, price, warrantyMonths = 0, category = "General", initialStock = 0 } = req.body;
    if (!name) return res.status(400).json({ error: "Product name required" });

    const newProduct = {
      id: makeId("prod_"),
      name,
      price: Number(price) || 0,
      warrantyMonths: Number(warrantyMonths) || 0,
      category,
      stock: Number(initialStock) || 0,
      image: req.file ? `/uploads/${req.file.filename}` : null,
      createdAt: new Date().toISOString()
    };

    db.products.push(newProduct);
    writeDB(db);
    res.json({ message: "Product added", product: newProduct });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Update stock for an existing product
app.post("/api/admin/stock", (req, res) => {
  const { productId, addQuantity } = req.body;
  const db = readDB();
  const p = db.products.find(x => x.id === productId);
  if (!p) return res.status(404).json({ error: "Product not found" });
  p.stock = (p.stock || 0) + Number(addQuantity || 0);
  writeDB(db);
  res.json({ message: "Stock updated", product: p });
});

// Place order (customer)
app.post("/api/orders", (req, res) => {
  const { name, phone, productId, quantity, serialNumber } = req.body;
  if (!name || !phone || !productId || !quantity) return res.status(400).json({ error: "Missing fields" });

  const db = readDB();
  const product = db.products.find(p => p.id === productId);
  if (!product) return res.status(404).json({ error: "Product not found" });

  if (product.stock < Number(quantity)) return res.status(400).json({ error: "Not enough stock" });

  // create order with status pending
  const order = {
    id: makeId("ord_"),
    name, phone, productId, quantity: Number(quantity),
    serialNumber: serialNumber || null,
    status: "PENDING",
    createdAt: new Date().toISOString()
  };
  db.orders.push(order);
  writeDB(db);
  res.json({ message: "Order placed (pending admin approval)", order });
});

// Admin: list orders (optionally filter by status)
app.get("/api/admin/orders", (req, res) => {
  const { status } = req.query;
  const db = readDB();
  let orders = db.orders || [];
  if (status) orders = orders.filter(o => o.status === status);
  // include product info
  orders = orders.map(o => ({ ...o, product: db.products.find(p => p.id === o.productId) }));
  res.json(orders);
});

// Admin: approve order -> reduces stock, calculates warranty expiry and sets status
app.post("/api/admin/orders/:id/approve", (req, res) => {
  const orderId = req.params.id;
  const db = readDB();
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "PENDING") return res.status(400).json({ error: "Order not pending" });

  const product = db.products.find(p => p.id === order.productId);
  if (!product) return res.status(404).json({ error: "Product not found for order" });
  if ((product.stock || 0) < order.quantity) return res.status(400).json({ error: "Insufficient stock" });

  // reduce stock
  product.stock -= order.quantity;

  // calculate warranty expiry based on approval date + product warranty months
  const approvedAt = new Date();
  let warrantyExpiry = null;
  if (product.warrantyMonths && product.warrantyMonths > 0) {
    const expiry = new Date(approvedAt);
    expiry.setMonth(expiry.getMonth() + Number(product.warrantyMonths));
    warrantyExpiry = expiry.toISOString();
  }

  order.status = "APPROVED";
  order.approvedAt = approvedAt.toISOString();
  order.warrantyExpiry = warrantyExpiry;

  writeDB(db);
  res.json({ message: "Order approved", order });
});

// Admin: reject order
app.post("/api/admin/orders/:id/reject", (req, res) => {
  const orderId = req.params.id;
  const db = readDB();
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  order.status = "REJECTED";
  order.rejectedAt = new Date().toISOString();
  writeDB(db);
  res.json({ message: "Order rejected", order });
});

// Search endpoint: search by name / product name / serial / category
app.get("/api/search", (req, res) => {
  const { q } = req.query;
  const db = readDB();
  if (!q) return res.json([]);
  const qq = q.toLowerCase();
  const products = db.products.filter(p =>
    p.name.toLowerCase().includes(qq) ||
    (p.category || "").toLowerCase().includes(qq)
  );
  const orders = db.orders.filter(o =>
    (o.name && o.name.toLowerCase().includes(qq)) ||
    (o.serialNumber && o.serialNumber.toLowerCase().includes(qq))
  );
  res.json({ products, orders });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
