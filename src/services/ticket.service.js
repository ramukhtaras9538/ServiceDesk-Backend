const { getDb, nextId, runTransaction } = require("../db");
const { forbidden, notFound, badRequest } = require("../utils/errors");

const dateValue = (value) => (value ? new Date(value).toISOString() : null);
const regexText = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const optionDefaults = {
  priorities: ["low", "medium", "high", "critical"],
  statuses: ["open", "in_progress", "resolved"],
};

async function configuredOptions(db, kind, session) {
  const options = await db
    .collection("ticketOptions")
    .findOne({ _id: kind }, { session });
  return options?.values ?? optionDefaults[kind];
}

function mapTicket(ticket) {
  return {
    id: ticket._id,
    code: ticket.code,
    category: ticket.categoryName,
    categoryId: ticket.categoryId,
    service: ticket.serviceName,
    serviceId: ticket.serviceId,
    department: ticket.departmentName,
    departmentId: ticket.departmentId,
    asset: ticket.asset,
    description: ticket.description ?? null,
    priority: ticket.priority,
    expectedClosingDays: ticket.expectedClosingDays ?? null,
    location: {
      block: ticket.block ?? null,
      floor: ticket.floor ?? null,
      room: ticket.room ?? null,
    },
    status: ticket.status,
    createdBy: ticket.createdBy,
    assignedTo: ticket.assignedTo ?? null,
    resolverOnLeave: ticket.resolverOnLeave ?? null,
    parentTicket: ticket.parentTicket ?? null,
    createdAt: dateValue(ticket.createdAt),
    updatedAt: dateValue(ticket.updatedAt),
    resolvedAt: dateValue(ticket.resolvedAt),
  };
}

function canView(user, ticket) {
  if (user.role === "admin") return true;
  if (
    ticket.createdById === user._id ||
    ticket.assignedToId === user._id ||
    ticket.participantIds?.includes(user._id)
  )
    return true;
  return user.role === "agent" && user.departmentId === ticket.departmentId;
}

function scopeFilter(user, scope, includeParticipants = true) {
  if (scope === "assigned") {
    return includeParticipants
      ? {
          $or: [{ assignedToId: user._id }, { participantIds: user._id }],
        }
      : { assignedToId: user._id };
  }
  if (scope === "all" && user.role === "admin") return {};
  if (scope === "department" && user.role === "agent" && user.departmentId) {
    return {
      $or: [{ departmentId: user.departmentId }, { participantIds: user._id }],
    };
  }
  return includeParticipants
    ? { $or: [{ createdById: user._id }, { participantIds: user._id }] }
    : { createdById: user._id };
}

function addSearch(filter, search, fields, includeTicketId = false) {
  if (!search) return;
  const expression = new RegExp(regexText(search), "i");
  const searchFields = fields.map((field) => ({ [field]: expression }));
  if (includeTicketId && /^\d+$/.test(search)) {
    searchFields.push({ _id: Number(search) });
  }
  const searchConditions = { $or: searchFields };
  if (filter.$or) {
    filter.$and = [
      ...(filter.$and ?? []),
      { $or: filter.$or },
      searchConditions,
    ];
    delete filter.$or;
  } else {
    filter.$or = searchConditions.$or;
  }
}

async function list(user, query) {
  const db = getDb();
  const baseFilter = scopeFilter(user, query.scope);
  if (query.linkedOnly) baseFilter.parentTicket = { $exists: true };
  if (query.department) baseFilter.departmentId = query.department;
  if (query.priority) baseFilter.priority = query.priority;
  addSearch(
    baseFilter,
    query.search,
    [
      "code",
      "asset",
      "description",
      "serviceName",
      "categoryName",
      "departmentName",
      "block",
      "floor",
      "room",
    ],
    true,
  );

  const groupedCounts = await db
    .collection("tickets")
    .aggregate([
      { $match: baseFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();
  const counts = Object.fromEntries(
    groupedCounts.map(({ _id, count }) => [_id, count]),
  );

  let rowsFilter = baseFilter;
  if (query.status) {
    rowsFilter = { ...baseFilter, status: query.status };
  } else if (query.statusGroup === "resolved") {
    rowsFilter = { ...baseFilter, status: "resolved" };
  } else if (query.statusGroup === "open") {
    rowsFilter = { ...baseFilter, status: { $ne: "resolved" } };
  }
  const [total, rows] = await Promise.all([
    db.collection("tickets").countDocuments(rowsFilter),
    db
      .collection("tickets")
      .find(rowsFilter)
      .sort(
        query.sort === "updated"
          ? { updatedAt: -1, _id: -1 }
          : { createdAt: -1, _id: -1 },
      )
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .toArray(),
  ]);

  return {
    data: rows.map(mapTicket),
    total,
    page: query.page,
    limit: query.limit,
    counts,
  };
}

async function getById(user, id) {
  const db = getDb();
  const ticket = await db.collection("tickets").findOne({ _id: id });
  if (!ticket) throw notFound("Ticket not found");
  if (!canView(user, ticket)) throw forbidden();

  const [comments, activities, links] = await Promise.all([
    db
      .collection("comments")
      .find({ ticketId: id })
      .sort({ createdAt: 1, _id: 1 })
      .toArray(),
    db
      .collection("activities")
      .find({ ticketId: id })
      .sort({ createdAt: 1, _id: 1 })
      .toArray(),
    db
      .collection("ticketLinks")
      .find({ $or: [{ sourceTicketId: id }, { linkedTicketId: id }] })
      .sort({ createdAt: 1, _id: 1 })
      .toArray(),
  ]);
  const relatedTicketIds = [
    ...new Set(
      links.map((link) =>
        link.sourceTicketId === id ? link.linkedTicketId : link.sourceTicketId,
      ),
    ),
  ];
  const relatedTickets = relatedTicketIds.length
    ? await db
        .collection("tickets")
        .find(
          { _id: { $in: relatedTicketIds } },
          {
            projection: {
              _id: 1,
              code: 1,
              departmentName: 1,
              status: 1,
              parentTicket: 1,
            },
          },
        )
        .toArray()
    : [];
  const relatedById = new Map(relatedTickets.map((item) => [item._id, item]));

  return {
    ...mapTicket(ticket),
    linkedTickets: links.map((link) => {
      const relatedId =
        link.sourceTicketId === id ? link.linkedTicketId : link.sourceTicketId;
      const related = relatedById.get(relatedId);
      return {
        id: relatedId,
        code: related?.code ?? link.linkedTicketCode,
        department:
          related?.departmentName ??
          (link.sourceTicketId === id
            ? link.targetDepartmentName
            : link.sourceDepartmentName),
        status: related?.status ?? "unknown",
        note: link.note,
        createdAt: dateValue(link.createdAt),
        createdBy: link.createdBy,
      };
    }),
    attachments: (ticket.attachments ?? []).map((attachment) => ({
      id: attachment._id,
      name: attachment.original ?? attachment.filename ?? "Attachment",
      mimetype: attachment.mimetype,
      url: `/tickets/${id}/attachments/${attachment._id}`,
    })),
    comments: comments.map((comment) => ({
      id: comment._id,
      body: comment.body,
      createdAt: dateValue(comment.createdAt),
      author: comment.author,
    })),
    timeline: activities.map((activity) => ({
      id: activity._id,
      action: activity.action,
      detail: activity.detail ?? null,
      createdAt: dateValue(activity.createdAt),
      actor: activity.actor,
    })),
  };
}

async function log(ticket, user, action, detail = null, session) {
  const actor = { name: user.name, empId: user.empId };
  await getDb()
    .collection("activities")
    .insertOne(
      {
        _id: await nextId("activities", session),
        ticketId: ticket._id,
        ticketCode: ticket.code,
        ticketStatus: ticket.status,
        createdById: ticket.createdById,
        assignedToId: ticket.assignedToId,
        departmentId: ticket.departmentId,
        participantIds: [
          ...new Set([...(ticket.participantIds ?? []), user._id]),
        ],
        userId: user._id,
        actor,
        action,
        detail,
        createdAt: new Date(),
      },
      { session },
    );
}

async function notifyAssignment(userId, ticket, session) {
  return notifyUser(
    userId,
    ticket,
    "Ticket assigned to you",
    `${ticket.code} — ${ticket.asset}`,
    session,
  );
}

async function notifyUser(userId, ticket, title, body, session) {
  await getDb()
    .collection("notifications")
    .insertOne(
      {
        _id: await nextId("notifications", session),
        userId,
        ticketId: ticket._id,
        ticketCode: ticket.code,
        title,
        body,
        createdAt: new Date(),
        readAt: null,
      },
      { session },
    );
}

async function notifyLinkedStakeholders(user, ticket, detail, session) {
  if (!ticket.parentTicket) return;
  const [source, admins] = await Promise.all([
    getDb()
      .collection("tickets")
      .findOne({ _id: ticket.parentTicket.id }, { session }),
    getDb().collection("users").find({ role: "admin" }, { session }).toArray(),
  ]);
  const recipients = new Set(
    [
      source?.createdById,
      source?.assignedToId,
      ...admins.map((admin) => admin._id),
    ].filter(
      (userId) =>
        userId !== undefined && userId !== null && userId !== user._id,
    ),
  );
  for (const recipientId of recipients) {
    await notifyUser(
      recipientId,
      ticket,
      "Linked ticket updated",
      `${ticket.code}: ${detail}`,
      session,
    );
  }
}

async function pickAssignee(departmentId, session) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const leaves = await db
    .collection("leaves")
    .find({
      status: { $in: ["scheduled", "active"] },
      startDate: { $lte: today },
      endDate: { $gte: today },
    }, { session })
    .toArray();
  const unavailableIds = new Set(leaves.map((leave) => leave.agentId));
  const agents = await db
    .collection("users")
    .find({ role: "agent", departmentId }, { session })
    .sort({ _id: 1 })
    .toArray();
  const availableAgents = agents.filter((agent) => !unavailableIds.has(agent._id));
  if (!availableAgents.length) return null;

  const load = await db
    .collection("tickets")
    .aggregate(
      [
        {
          $match: {
            assignedToId: { $in: availableAgents.map((agent) => agent._id) },
            status: { $ne: "resolved" },
          },
        },
        { $group: { _id: "$assignedToId", count: { $sum: 1 } } },
      ],
      { session },
    )
    .toArray();
  const counts = new Map(load.map((item) => [item._id, item.count]));
  availableAgents.sort(
    (left, right) =>
      (counts.get(left._id) ?? 0) - (counts.get(right._id) ?? 0) ||
      left._id - right._id,
  );
  return availableAgents[0];
}

async function create(user, input, files) {
  return runTransaction(async (session, db) => {
    const priorities = await configuredOptions(db, "priorities", session);
    if (!priorities.includes(input.priority))
      throw badRequest("priority: unknown priority");
    const service = await db
      .collection("services")
      .findOne({ _id: input.serviceId }, { session });
    const category = await db
      .collection("categories")
      .findOne({ _id: input.categoryId }, { session });
    const department = await db
      .collection("departments")
      .findOne({ _id: input.departmentId }, { session });
    if (!service) throw badRequest("serviceId: unknown service");
    if (service.categoryId !== input.categoryId) {
      throw badRequest("serviceId: service does not belong to this category");
    }
    if (service.departmentId !== input.departmentId) {
      throw badRequest(
        "departmentId: service does not belong to this department",
      );
    }
    if (!category) throw badRequest("categoryId: unknown category");
    if (!department) throw badRequest("departmentId: unknown department");

    const id = await nextId("tickets", session);
    const createdAt = new Date();
    const assignee = await pickAssignee(input.departmentId, session);
    const attachments = [];
    for (const file of files || []) {
      attachments.push({
        _id: await nextId("attachments", session),
        original: file.originalname,
        mimetype: file.mimetype,
      });
    }

    const ticket = {
      _id: id,
      code: `TKT-${createdAt.getFullYear()}-${String(id).padStart(4, "0")}`,
      categoryId: input.categoryId,
      categoryName: category.name,
      serviceId: service._id,
      serviceName: service.name,
      departmentId: department._id,
      departmentName: department.name,
      asset: input.asset,
      description: input.description || null,
      priority: input.priority,
      expectedClosingDays: input.expectedClosingDays ?? null,
      block: input.block || null,
      floor: input.floor || null,
      room: input.room || null,
      status: "open",
      createdById: user._id,
      createdBy: { id: user._id, name: user.name, empId: user.empId },
      assignedToId: assignee?._id ?? null,
      assignedTo: assignee
        ? { id: assignee._id, name: assignee.name, empId: assignee.empId }
        : null,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      attachments,
    };

    await db.collection("tickets").insertOne(ticket, { session });
    if (files?.length) {
      const attachmentDocs = files.map((file, index) => ({
        _id: ticket.attachments[index]._id,
        data: file.buffer,
        mimetype: file.mimetype,
        original: file.originalname,
      }));
      await db
        .collection("attachmentFiles")
        .insertMany(attachmentDocs, { session });
    }
    await log(ticket, user, "created", `Ticket ${ticket.code} raised`, session);
    if (assignee) {
      await log(
        ticket,
        user,
        "assigned",
        "Auto-assigned to the least-loaded department agent",
        session,
      );
      await notifyAssignment(assignee._id, ticket, session);
    }
    return ticket._id;
  });
}

async function updateStatus(user, id, status) {
  await runTransaction(async (session, db) => {
    const statuses = await configuredOptions(db, "statuses", session);
    if (!statuses.includes(status)) throw badRequest("status: unknown status");
    const ticket = await db
      .collection("tickets")
      .findOne({ _id: id }, { session });
    if (!ticket) throw notFound("Ticket not found");
    if (!(user.role === "admin" || ticket.assignedToId === user._id)) {
      throw forbidden(
        "Only the assigned agent or an admin can change the status",
      );
    }
    if (ticket.status === status) return;

    const now = new Date();
    const updatedTicket = {
      ...ticket,
      status,
      updatedAt: now,
      resolvedAt: status === "resolved" ? now : null,
    };
    await db.collection("tickets").updateOne(
      { _id: id },
      {
        $set: {
          status,
          updatedAt: now,
          resolvedAt: updatedTicket.resolvedAt,
        },
      },
      { session },
    );
    await log(
      { ...updatedTicket, status },
      user,
      "status",
      `Status changed from ${ticket.status} to ${status}`,
      session,
    );
    await notifyLinkedStakeholders(
      user,
      { ...ticket, status },
      `status changed to ${status}`,
      session,
    );
  });
}

async function assign(user, id, assigneeId, note) {
  await runTransaction(async (session, db) => {
    const ticket = await db
      .collection("tickets")
      .findOne({ _id: id }, { session });
    if (!ticket) throw notFound("Ticket not found");
    if (
      !(
        user.role === "admin" ||
        (user.role === "agent" && user.departmentId === ticket.departmentId)
      )
    ) {
      throw forbidden(
        "Only an admin or an agent in this department can assign the ticket",
      );
    }
    const target = await db.collection("users").findOne(
      {
        _id: assigneeId,
        role: "agent",
        departmentId: ticket.departmentId,
      },
      { session },
    );
    if (!target)
      throw badRequest("assigneeId: must be an agent in the ticket department");
    const today = new Date().toISOString().slice(0, 10);
    const targetLeave = await db.collection("leaves").findOne({
      agentId: assigneeId,
      status: { $in: ["scheduled", "active"] },
      startDate: { $lte: today },
      endDate: { $gte: today },
    }, { session });
    if (targetLeave) {
      throw badRequest("assigneeId: cannot assign a ticket to a resolver on leave");
    }
    if (ticket.assignedToId === assigneeId) return;
    const previousAssigneeId = ticket.assignedToId;
    const previousAssignee = ticket.assignedTo ?? null;
    if (previousAssigneeId && !note) {
      throw badRequest(
        "note: add a note explaining why the ticket is being reassigned",
      );
    }

    const updatedTicket = {
      ...ticket,
      assignedToId: assigneeId,
      assignedTo: { id: target._id, name: target.name, empId: target.empId },
      updatedAt: new Date(),
    };
    delete updatedTicket.leaveAssignment;
    delete updatedTicket.resolverOnLeave;
    await db.collection("tickets").updateOne(
      { _id: id },
      {
        $set: {
          assignedToId: assigneeId,
          assignedTo: updatedTicket.assignedTo,
          updatedAt: updatedTicket.updatedAt,
        },
        $unset: { leaveAssignment: "", resolverOnLeave: "" },
      },
      { session },
    );
    await log(
      updatedTicket,
      user,
      "assigned",
      previousAssignee
        ? `Reassigned from ${previousAssignee.name} to ${target.name}. Note: ${note}`
        : `Assigned to ${target.name}${note ? `. Note: ${note}` : ""}`,
      session,
    );
    await notifyAssignment(assigneeId, updatedTicket, session);
    if (previousAssigneeId) {
      await notifyUser(
        previousAssigneeId,
        updatedTicket,
        "Ticket reassigned",
        `${ticket.code} was reassigned to ${target.name}. Note: ${note}`,
        session,
      );
    }
    await notifyLinkedStakeholders(
      user,
      updatedTicket,
      previousAssignee
        ? `reassigned to ${target.name}. Note: ${note}`
        : `assigned to ${target.name}`,
      session,
    );
  });
}

async function createLinkedTicket(user, id, input) {
  return runTransaction(async (session, db) => {
    const source = await db
      .collection("tickets")
      .findOne({ _id: id }, { session });
    if (!source) throw notFound("Ticket not found");
    if (!canView(user, source)) throw forbidden();
    if (user.role !== "admin" && user.role !== "agent") {
      throw forbidden("Only resolvers can create cross-department tickets");
    }
    if (input.departmentId === source.departmentId) {
      throw badRequest("departmentId: choose a different department");
    }

    const [service, category, department] = await Promise.all([
      db.collection("services").findOne({ _id: input.serviceId }, { session }),
      db
        .collection("categories")
        .findOne({ _id: input.categoryId }, { session }),
      db
        .collection("departments")
        .findOne({ _id: input.departmentId }, { session }),
    ]);
    if (!service) throw badRequest("serviceId: unknown service");
    if (!category) throw badRequest("categoryId: unknown category");
    if (!department) throw badRequest("departmentId: unknown department");
    if (service.categoryId !== input.categoryId) {
      throw badRequest("serviceId: service does not belong to this category");
    }
    if (service.departmentId !== input.departmentId) {
      throw badRequest(
        "departmentId: service does not belong to this department",
      );
    }

    const now = new Date();
    const ticketId = await nextId("tickets", session);
    const assignee = await pickAssignee(input.departmentId, session);
    const participantIds = [
      ...new Set(
        [
          source.createdById,
          source.assignedToId,
          user._id,
          assignee?._id,
        ].filter(
          (participantId) =>
            participantId !== null && participantId !== undefined,
        ),
      ),
    ];
    const linkedTicket = {
      _id: ticketId,
      code: `TKT-${now.getFullYear()}-${String(ticketId).padStart(4, "0")}`,
      categoryId: category._id,
      categoryName: category.name,
      serviceId: service._id,
      serviceName: service.name,
      departmentId: department._id,
      departmentName: department.name,
      asset: input.asset,
      description: input.description || null,
      priority: input.priority ?? source.priority,
      expectedClosingDays: null,
      block: source.block ?? null,
      floor: source.floor ?? null,
      room: source.room ?? null,
      status: "open",
      createdById: source.createdById,
      createdBy: source.createdBy,
      assignedToId: assignee?._id ?? null,
      assignedTo: assignee
        ? { id: assignee._id, name: assignee.name, empId: assignee.empId }
        : null,
      participantIds,
      parentTicket: { id: source._id, code: source.code },
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      attachments: [],
    };
    await db.collection("tickets").insertOne(linkedTicket, { session });

    const link = {
      _id: await nextId("ticketLinks", session),
      sourceTicketId: source._id,
      sourceTicketCode: source.code,
      linkedTicketId: linkedTicket._id,
      linkedTicketCode: linkedTicket.code,
      sourceDepartmentId: source.departmentId,
      sourceDepartmentName: source.departmentName,
      targetDepartmentId: department._id,
      targetDepartmentName: department.name,
      createdBy: { id: user._id, name: user.name, empId: user.empId },
      note: input.note,
      createdAt: now,
    };
    await db.collection("ticketLinks").insertOne(link, { session });
    await db.collection("tickets").updateOne(
      { _id: source._id },
      {
        $set: { updatedAt: now },
        $addToSet: {
          participantIds: {
            $each: [user._id, ...(assignee ? [assignee._id] : [])],
          },
        },
      },
      { session },
    );
    await log(
      {
        ...source,
        updatedAt: now,
        participantIds: [
          ...new Set([
            ...(source.participantIds ?? []),
            user._id,
            ...(assignee ? [assignee._id] : []),
          ]),
        ],
      },
      user,
      "linked",
      `Linked ${linkedTicket.code} to ${department.name}. Note: ${input.note}`,
      session,
    );
    await log(
      linkedTicket,
      user,
      "created",
      `Created for ${department.name} from ${source.code}. Note: ${input.note}`,
      session,
    );
    if (assignee) {
      await log(
        linkedTicket,
        user,
        "assigned",
        "Auto-assigned to the least-loaded department agent",
        session,
      );
      await notifyUser(
        assignee._id,
        linkedTicket,
        "Cross-department ticket assigned",
        `${linkedTicket.code} was linked from ${source.code}: ${input.asset}`,
        session,
      );
    }

    const admins = await db
      .collection("users")
      .find({ role: "admin" }, { session })
      .toArray();
    const notifiedUsers = new Set(
      [source.createdById, source.assignedToId, user._id].filter(
        (recipientId) =>
          recipientId !== null &&
          recipientId !== undefined &&
          recipientId !== user._id &&
          recipientId !== assignee?._id,
      ),
    );
    for (const admin of admins) {
      if (admin._id !== user._id && admin._id !== assignee?._id) {
        notifiedUsers.add(admin._id);
      }
    }
    for (const recipientId of notifiedUsers) {
      await notifyUser(
        recipientId,
        linkedTicket,
        "A cross-department ticket was linked",
        `${linkedTicket.code} was created for ${department.name} from ${source.code}`,
        session,
      );
    }
    return linkedTicket._id;
  });
}

async function listLinkedTickets() {
  const db = getDb();
  const links = await db
    .collection("ticketLinks")
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .toArray();
  const ticketIds = [
    ...new Set(
      links.flatMap((link) => [link.sourceTicketId, link.linkedTicketId]),
    ),
  ];
  const tickets = ticketIds.length
    ? await db
        .collection("tickets")
        .find(
          { _id: { $in: ticketIds } },
          { projection: { _id: 1, code: 1, status: 1, departmentName: 1 } },
        )
        .toArray()
    : [];
  const ticketsById = new Map(tickets.map((ticket) => [ticket._id, ticket]));
  return links.map((link) => ({
    id: link._id,
    sourceTicketId: link.sourceTicketId,
    sourceTicketCode: link.sourceTicketCode,
    linkedTicketId: link.linkedTicketId,
    linkedTicketCode: link.linkedTicketCode,
    sourceDepartment:
      ticketsById.get(link.sourceTicketId)?.departmentName ??
      link.sourceDepartmentName,
    targetDepartment:
      ticketsById.get(link.linkedTicketId)?.departmentName ??
      link.targetDepartmentName,
    sourceStatus: ticketsById.get(link.sourceTicketId)?.status ?? "unknown",
    linkedStatus: ticketsById.get(link.linkedTicketId)?.status ?? "unknown",
    note: link.note,
    createdBy: link.createdBy,
    createdAt: dateValue(link.createdAt),
  }));
}

async function getAttachment(user, ticketId, attachmentId) {
  const ticket = await getDb().collection("tickets").findOne({ _id: ticketId });
  if (!ticket) throw notFound("Ticket not found");
  if (!canView(user, ticket)) throw forbidden();
  const attachment = (ticket.attachments ?? []).find(
    (item) => item._id === attachmentId,
  );
  if (!attachment) throw notFound("Attachment not found");
  const file = await getDb()
    .collection("attachmentFiles")
    .findOne({ _id: attachmentId });
  if (!file) throw notFound("Attachment file not found");
  const data = Buffer.isBuffer(file.data)
    ? file.data
    : typeof file.data?.value === "function"
      ? Buffer.from(file.data.value())
      : Buffer.from(file.data);
  return { data, mimetype: file.mimetype };
}

async function addComment(user, id, body) {
  await runTransaction(async (session, db) => {
    const ticket = await db
      .collection("tickets")
      .findOne({ _id: id }, { session });
    if (!ticket) throw notFound("Ticket not found");
    if (!canView(user, ticket)) throw forbidden();

    const createdAt = new Date();
    await db.collection("comments").insertOne(
      {
        _id: await nextId("comments", session),
        ticketId: id,
        userId: user._id,
        author: { name: user.name, empId: user.empId, role: user.role },
        body,
        createdAt,
      },
      { session },
    );
    await db
      .collection("tickets")
      .updateOne({ _id: id }, { $set: { updatedAt: createdAt } }, { session });
    await log(
      { ...ticket, updatedAt: createdAt },
      user,
      "comment",
      body.length > 80 ? `${body.slice(0, 80)}…` : body,
      session,
    );
    await notifyLinkedStakeholders(
      user,
      ticket,
      "a new comment was added",
      session,
    );
  });
}

async function listActivity(user, query) {
  const db = getDb();
  const activityFilter = scopeFilter(user, query.scope);
  if (query.date) {
    const start = new Date(`${query.date}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    activityFilter.createdAt = { $gte: start, $lt: end };
  }
  if (query.search) {
    addSearch(activityFilter, query.search, ["ticketCode", "detail", "action"]);
  }
  const rows = await db
    .collection("activities")
    .find(activityFilter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((query.page - 1) * query.limit)
    .limit(query.limit)
    .toArray();
  return rows.map((activity) => ({
    id: activity._id,
    action: activity.action,
    detail: activity.detail ?? null,
    createdAt: dateValue(activity.createdAt),
    ticketId: activity.ticketId,
    ticketCode: activity.ticketCode,
    ticketStatus: activity.ticketStatus,
    actor: activity.actor.name,
  }));
}

async function listNotifications(user) {
  const notifications = await getDb()
    .collection("notifications")
    .find({ userId: user._id })
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .toArray();
  const result = notifications.map((item) => ({
    id: item._id,
    ticketId: item.ticketId ?? null,
    ticketCode: item.ticketCode ?? null,
    title: item.title,
    body: item.body,
    createdAt: dateValue(item.createdAt),
    readAt: dateValue(item.readAt),
  }));
  return {
    notifications: result,
    unreadCount: result.reduce(
      (count, item) => count + (item.readAt ? 0 : 1),
      0,
    ),
  };
}

async function markNotificationRead(user, id) {
  const result = await getDb()
    .collection("notifications")
    .updateOne(
      { _id: id, userId: user._id, readAt: null },
      { $set: { readAt: new Date() } },
    );
  if (result.matchedCount === 0) {
    const notification = await getDb().collection("notifications").findOne({
      _id: id,
      userId: user._id,
    });
    if (!notification) throw notFound("Notification not found");
  }
}

module.exports = {
  list,
  getById,
  create,
  updateStatus,
  assign,
  createLinkedTicket,
  listLinkedTickets,
  listNotifications,
  markNotificationRead,
  getAttachment,
  addComment,
  listActivity,
};
