const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { connectDb, getDb, nextId, closeDb } = require("./index");

const initialAdminSchema = z.object({
  empId: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
});

const departments = [
  "IT Services",
  "Electrical",
  "Civil & Maintenance",
  "Housekeeping",
  "Hostel Office",
  "Transport",
  "Library",
  "Laboratory Support",
];

const categories = {
  "IT & Network": [
    ["Wi-Fi / network issue", "IT Services"],
    ["Computer or printer repair", "IT Services"],
    ["Software installation", "IT Services"],
  ],
  Electrical: [
    ["Light or fan repair", "Electrical"],
    ["Power outage", "Electrical"],
    ["AC service", "Electrical"],
  ],
  "Civil & Furniture": [
    ["Furniture repair", "Civil & Maintenance"],
    ["Plumbing", "Civil & Maintenance"],
    ["Door / window repair", "Civil & Maintenance"],
  ],
  Cleaning: [
    ["Classroom cleaning", "Housekeeping"],
    ["Washroom cleaning", "Housekeeping"],
  ],
  Hostel: [
    ["Room maintenance", "Hostel Office"],
    ["Mess complaint", "Hostel Office"],
  ],
  Transport: [["Bus route issue", "Transport"]],
};

async function seed() {
  await connectDb();
  const db = getDb();
  const departmentIds = new Map();

  for (const name of departments) {
    let department = await db.collection("departments").findOne({ name });
    if (!department) {
      department = { _id: await nextId("departments"), name };
      await db.collection("departments").insertOne(department);
    }
    departmentIds.set(name, department._id);
  }

  for (const [categoryName, services] of Object.entries(categories)) {
    let category = await db
      .collection("categories")
      .findOne({ name: categoryName });
    if (!category) {
      category = { _id: await nextId("categories"), name: categoryName };
      await db.collection("categories").insertOne(category);
    }

    for (const [serviceName, departmentName] of services) {
      const departmentId = departmentIds.get(departmentName);
      const existing = await db.collection("services").findOne({
        name: serviceName,
        categoryId: category._id,
      });
      if (!existing) {
        await db.collection("services").insertOne({
          _id: await nextId("services"),
          name: serviceName,
          categoryId: category._id,
          departmentId,
        });
      }
    }
  }

  const admin = initialAdminSchema.parse({
    empId: process.env.INITIAL_ADMIN_EMP_ID,
    name: process.env.INITIAL_ADMIN_NAME,
    email: process.env.INITIAL_ADMIN_EMAIL,
    password: process.env.INITIAL_ADMIN_PASSWORD,
  });
  const empIdNormalized = admin.empId.toLowerCase();
  const existingAdmin = await db.collection("users").findOne({
    empIdNormalized,
  });
  if (!existingAdmin) {
    await db.collection("users").insertOne({
      _id: await nextId("users"),
      empId: admin.empId,
      empIdNormalized,
      name: admin.name,
      email: admin.email,
      passwordHash: await bcrypt.hash(admin.password, 12),
      role: "admin",
      departmentId: null,
    });
  }
}

if (require.main === module) {
  seed()
    .then(async () => {
      console.log("MongoDB seed complete.");
      console.log(
        "Initial administrator created if the employee ID was not already present.",
      );
    })
    .catch((error) => {
      console.error("MongoDB seed failed:", error);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}

module.exports = { seed };
