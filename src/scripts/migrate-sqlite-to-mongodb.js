const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const env = require("../config/env");
const { connectDb, getDb, closeDb } = require("../db");

const toDate = (value) => {
  if (!value) return null;
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
};

async function upsertDocuments(collectionName, documents) {
  if (!documents.length) return;
  const collection = getDb().collection(collectionName);
  const operations = documents.map((document) => ({
    updateOne: {
      filter: { _id: document._id },
      update: { $setOnInsert: document },
      upsert: true,
    },
  }));
  const batchSize = collectionName === "attachmentFiles" ? 5 : 500;
  for (let offset = 0; offset < operations.length; offset += batchSize) {
    await collection.bulkWrite(operations.slice(offset, offset + batchSize), {
      ordered: false,
    });
  }
  console.log(
    `Imported ${documents.length} ${collectionName} records (existing MongoDB records were preserved).`,
  );
}

async function migrate() {
  const sourcePath = path.resolve(env.SQLITE_SOURCE);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SQLite source database was not found: ${sourcePath}`);
  }

  const sqlite = new Database(sourcePath, { readonly: true });
  try {
    const source = {
      departments: sqlite
        .prepare("SELECT * FROM departments ORDER BY id")
        .all(),
      categories: sqlite.prepare("SELECT * FROM categories ORDER BY id").all(),
      services: sqlite.prepare("SELECT * FROM services ORDER BY id").all(),
      users: sqlite.prepare("SELECT * FROM users ORDER BY id").all(),
      tickets: sqlite.prepare("SELECT * FROM tickets ORDER BY id").all(),
      attachments: sqlite
        .prepare("SELECT * FROM attachments ORDER BY id")
        .all(),
      comments: sqlite.prepare("SELECT * FROM comments ORDER BY id").all(),
      activities: sqlite.prepare("SELECT * FROM activities ORDER BY id").all(),
      notifications: sqlite
        .prepare("SELECT * FROM notifications ORDER BY id")
        .all(),
    };
    await connectDb();
    const db = getDb();
    const usersById = new Map(source.users.map((user) => [user.id, user]));
    const categoriesById = new Map(
      source.categories.map((category) => [category.id, category]),
    );
    const departmentsById = new Map(
      source.departments.map((department) => [department.id, department]),
    );
    const servicesById = new Map(
      source.services.map((service) => [service.id, service]),
    );
    const ticketsById = new Map(
      source.tickets.map((ticket) => [ticket.id, ticket]),
    );
    const attachmentsByTicket = new Map();
    const attachmentFiles = [];

    for (const attachment of source.attachments) {
      const items = attachmentsByTicket.get(attachment.ticket_id) ?? [];
      items.push({
        _id: attachment.id,
        filename: attachment.filename,
        original: attachment.original,
        mimetype: attachment.mimetype,
      });
      attachmentsByTicket.set(attachment.ticket_id, items);

      const filePath = path.resolve(env.UPLOAD_DIR, attachment.filename);
      if (fs.existsSync(filePath)) {
        attachmentFiles.push({
          _id: attachment.id,
          data: fs.readFileSync(filePath),
          mimetype: attachment.mimetype || "application/octet-stream",
          original: attachment.original || attachment.filename,
        });
      } else {
        console.warn(
          `Attachment file is missing and was not copied: ${filePath}`,
        );
      }
    }

    await upsertDocuments(
      "departments",
      source.departments.map((item) => ({
        _id: item.id,
        name: item.name,
      })),
    );
    await upsertDocuments(
      "categories",
      source.categories.map((item) => ({
        _id: item.id,
        name: item.name,
      })),
    );
    await upsertDocuments(
      "services",
      source.services.map((item) => ({
        _id: item.id,
        name: item.name,
        categoryId: item.category_id,
        departmentId: item.department_id,
      })),
    );
    await upsertDocuments(
      "users",
      source.users.map((item) => ({
        _id: item.id,
        empId: item.emp_id,
        empIdNormalized: item.emp_id.toLowerCase(),
        name: item.name,
        email: item.email,
        passwordHash: item.password_hash,
        role: item.role,
        departmentId: item.department_id,
      })),
    );

    const ticketDocuments = source.tickets.map((item) => {
      const category = categoriesById.get(item.category_id);
      const service = servicesById.get(item.service_id);
      const department = departmentsById.get(item.department_id);
      const creator = usersById.get(item.created_by);
      const assignee = usersById.get(item.assigned_to);
      if (!category || !service || !department || !creator) {
        throw new Error(
          `Ticket ${item.id} refers to missing catalog or user records`,
        );
      }
      return {
        _id: item.id,
        code: item.code,
        categoryId: item.category_id,
        categoryName: category.name,
        serviceId: item.service_id,
        serviceName: service.name,
        departmentId: item.department_id,
        departmentName: department.name,
        asset: item.asset,
        description: item.description,
        priority: item.priority,
        expectedClosingDays: item.expected_closing_days,
        block: item.block,
        floor: item.floor,
        room: item.room,
        status: item.status,
        createdById: item.created_by,
        createdBy: {
          id: creator.id,
          name: creator.name,
          empId: creator.emp_id,
        },
        assignedToId: item.assigned_to,
        assignedTo: assignee
          ? { id: assignee.id, name: assignee.name, empId: assignee.emp_id }
          : null,
        createdAt: toDate(item.created_at),
        updatedAt: toDate(item.updated_at),
        resolvedAt: toDate(item.resolved_at),
        attachments: attachmentsByTicket.get(item.id) ?? [],
      };
    });
    await upsertDocuments("tickets", ticketDocuments);
    await upsertDocuments("attachmentFiles", attachmentFiles);
    await upsertDocuments(
      "comments",
      source.comments.map((item) => {
        const user = usersById.get(item.user_id);
        if (!user)
          throw new Error(
            `Comment ${item.id} refers to missing user ${item.user_id}`,
          );
        return {
          _id: item.id,
          ticketId: item.ticket_id,
          userId: item.user_id,
          author: { name: user.name, empId: user.emp_id, role: user.role },
          body: item.body,
          createdAt: toDate(item.created_at),
        };
      }),
    );
    await upsertDocuments(
      "activities",
      source.activities.map((item) => {
        const user = usersById.get(item.user_id);
        const ticket = ticketsById.get(item.ticket_id);
        if (!user || !ticket)
          throw new Error(`Activity ${item.id} refers to missing records`);
        return {
          _id: item.id,
          ticketId: item.ticket_id,
          ticketCode: ticket.code,
          ticketStatus: ticket.status,
          createdById: ticket.created_by,
          assignedToId: ticket.assigned_to,
          departmentId: ticket.department_id,
          userId: item.user_id,
          actor: { name: user.name, empId: user.emp_id },
          action: item.action,
          detail: item.detail,
          createdAt: toDate(item.created_at),
        };
      }),
    );
    await upsertDocuments(
      "notifications",
      source.notifications.map((item) => {
        const ticket = ticketsById.get(item.ticket_id);
        if (!ticket)
          throw new Error(
            `Notification ${item.id} refers to missing ticket ${item.ticket_id}`,
          );
        return {
          _id: item.id,
          userId: item.user_id,
          ticketId: item.ticket_id,
          ticketCode: ticket.code,
          title: item.title,
          body: item.body,
          createdAt: toDate(item.created_at),
          readAt: toDate(item.read_at),
        };
      }),
    );

    const counters = {
      departments: source.departments,
      categories: source.categories,
      services: source.services,
      users: source.users,
      tickets: source.tickets,
      attachments: source.attachments,
      comments: source.comments,
      activities: source.activities,
      notifications: source.notifications,
    };
    for (const [name, rows] of Object.entries(counters)) {
      const maxId = rows.reduce((max, row) => Math.max(max, row.id), 0);
      if (maxId) {
        await db
          .collection("counters")
          .updateOne(
            { _id: name },
            { $max: { value: maxId } },
            { upsert: true },
          );
      }
    }
    console.log(`SQLite data migration complete from ${sourcePath}.`);
    console.log(
      "SQLite files were not modified. Keep them as a backup until you verify the MongoDB data.",
    );
  } finally {
    sqlite.close();
  }
}

migrate()
  .catch((error) => {
    console.error("SQLite to MongoDB migration failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
