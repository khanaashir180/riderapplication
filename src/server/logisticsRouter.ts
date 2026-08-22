import { Router } from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import {
  parseOmsCsv,
  reconcileCourierCsv,
  calculateCourierPerformance,
  calculateLateByCourier,
  calculateCodStatus,
  resolveLogisticsStatus,
  DEFAULT_STATUS_MAPPINGS
} from '../services/logisticsService.js';
import {
  Shipment,
  ShipmentEvent,
  ImportJob,
  PhysicalReturnRecord,
  LogisticsException,
  CourierMapping,
  ReturnCondition,
  ReturnDisposition
} from '../types/logistics.js';

export function createLogisticsRouter(db: FirebaseFirestore.Firestore, requireAuth: any, requireRole: any) {
  const router = Router();

  // 1. LOGISTICS DASHBOARD SUMMARY
  router.get('/dashboard', requireAuth, requireRole('super_admin', 'dispatch_manager', 'management_viewer'), async (req: any, res: any) => {
    try {
      const shipmentsSnap = await db.collection('shipments').get();
      const shipments: Shipment[] = shipmentsSnap.docs.map(doc => doc.data() as Shipment);

      const exceptionsSnap = await db.collection('exceptions').where('status', '==', 'OPEN').get();
      const exceptionsCount = exceptionsSnap.size;

      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const thisMonthPrefix = now.toISOString().substring(0, 7);

      let totalActiveShipments = 0;
      let pendingDeliveries = 0;
      let lateByCourierCount = 0;
      let deliveredToday = 0;
      let deliveredThisMonth = 0;
      let returnMarkedCount = 0;
      let awaitingPhysicalReceipt = 0;
      let returnsPhysicallyReceivedToday = 0;
      let codPendingCount = 0;

      shipments.forEach(s => {
        // Active shipments
        if (s.logisticsStatus === 'PENDING_DELIVERY' || s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT') {
          totalActiveShipments++;
        }

        if (s.logisticsStatus === 'PENDING_DELIVERY') {
          pendingDeliveries++;
        }

        if (s.lateByCourier) {
          lateByCourierCount++;
        }

        if (s.logisticsStatus === 'DELIVERED') {
          if (s.courierDeliveredAt?.startsWith(todayStr)) {
            deliveredToday++;
          }
          if (s.courierDeliveredAt?.startsWith(thisMonthPrefix)) {
            deliveredThisMonth++;
          }
        }

        if (s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT' || s.logisticsStatus === 'RETURN_PHYSICALLY_RECEIVED') {
          returnMarkedCount++;
        }

        if (s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT') {
          awaitingPhysicalReceipt++;
        }

        if (s.physicalReturnReceived && s.physicalReturnReceivedAt?.startsWith(todayStr)) {
          returnsPhysicallyReceivedToday++;
        }

        if (s.codStatus === 'PENDING' || (s.logisticsStatus === 'DELIVERED' && s.codPending > 0)) {
          codPendingCount++;
        }
      });

      return res.json({
        success: true,
        data: {
          totalActiveShipments,
          pendingDeliveries,
          lateByCourier: lateByCourierCount,
          deliveredToday,
          deliveredThisMonth,
          returnMarked: returnMarkedCount,
          awaitingPhysicalReceipt,
          returnsPhysicallyReceivedToday,
          codPending: codPendingCount,
          exceptions: exceptionsCount
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 2. GET SHIPMENTS WITH FILTERS & SEARCH
  router.get('/shipments', requireAuth, requireRole('super_admin', 'dispatch_manager', 'customer_service', 'warehouse_staff', 'management_viewer'), async (req: any, res: any) => {
    try {
      const { status, late, courier, city, returnStatus, codStatus, search, page = '1', limit = '50' } = req.query;

      const shipmentsSnap = await db.collection('shipments').get();
      let shipments: Shipment[] = shipmentsSnap.docs.map(doc => doc.data() as Shipment);

      // Filtering in memory for rich multi-criteria search
      if (status) {
        shipments = shipments.filter(s => s.logisticsStatus === status);
      }

      if (late === 'true') {
        shipments = shipments.filter(s => s.lateByCourier === true);
      } else if (late === 'false') {
        shipments = shipments.filter(s => s.lateByCourier === false);
      }

      if (courier) {
        shipments = shipments.filter(s => s.courier.toLowerCase() === (courier as string).toLowerCase());
      }

      if (city) {
        shipments = shipments.filter(s => s.destinationCity.toLowerCase() === (city as string).toLowerCase());
      }

      if (returnStatus) {
        if (returnStatus === 'awaiting') {
          shipments = shipments.filter(s => s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT');
        } else if (returnStatus === 'received') {
          shipments = shipments.filter(s => s.physicalReturnReceived === true);
        }
      }

      if (codStatus) {
        shipments = shipments.filter(s => s.codStatus === codStatus);
      }

      if (search) {
        const q = (search as string).toLowerCase().trim();
        shipments = shipments.filter(s =>
          (s.trackingNumber && s.trackingNumber.toLowerCase().includes(q)) ||
          (s.orderNumber && s.orderNumber.toLowerCase().includes(q)) ||
          (s.parentOrderNumber && s.parentOrderNumber.toLowerCase().includes(q)) ||
          (s.customerName && s.customerName.toLowerCase().includes(q)) ||
          (s.customerPhone && s.customerPhone.toLowerCase().includes(q))
        );
      }

      // Sort newest first
      shipments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const pageNum = parseInt(page as string, 10) || 1;
      const limitNum = parseInt(limit as string, 10) || 50;
      const startIndex = (pageNum - 1) * limitNum;
      const paginated = shipments.slice(startIndex, startIndex + limitNum);

      return res.json({
        success: true,
        data: paginated,
        meta: {
          total: shipments.length,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(shipments.length / limitNum)
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 3. GET SINGLE SHIPMENT DETAIL
  router.get('/shipments/:id', requireAuth, requireRole('super_admin', 'dispatch_manager', 'customer_service', 'warehouse_staff', 'management_viewer'), async (req: any, res: any) => {
    try {
      const { id } = req.params;
      const docSnap = await db.collection('shipments').doc(id).get();
      if (!docSnap.exists) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Shipment not found' } });
      }

      const shipment = docSnap.data() as Shipment;

      // Fetch timeline events
      const eventsSnap = await db.collection('shipmentEvents')
        .where('shipmentId', '==', id)
        .get();
      const events: ShipmentEvent[] = eventsSnap.docs.map(doc => doc.data() as ShipmentEvent);
      events.sort((a, b) => new Date(b.eventTimestamp).getTime() - new Date(a.eventTimestamp).getTime());

      // Fetch physical return if any
      const returnSnap = await db.collection('physicalReturns')
        .where('shipmentId', '==', id)
        .get();
      const physicalReturn = returnSnap.empty ? null : returnSnap.docs[0].data() as PhysicalReturnRecord;

      // Fetch exceptions
      const excSnap = await db.collection('exceptions')
        .where('shipmentId', '==', id)
        .get();
      const exceptions = excSnap.docs.map(doc => doc.data() as LogisticsException);

      return res.json({
        success: true,
        data: {
          shipment,
          events,
          physicalReturn,
          exceptions
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 4. MANUAL ACTION ON SHIPMENT
  router.post('/shipments/:id/manual-action', requireAuth, requireRole('super_admin', 'dispatch_manager', 'customer_service', 'cashier', 'warehouse_staff'), async (req: any, res: any) => {
    try {
      const { id } = req.params;
      const { action, trackingNumber, courier, codReceived, notes } = req.body;

      const docRef = db.collection('shipments').doc(id);
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Shipment not found' } });
      }

      const shipment = docSnap.data() as Shipment;
      const prevStatus = shipment.logisticsStatus;
      const nowISO = new Date().toISOString();

      if (action === 'CORRECT_TRACKING') {
        if (!trackingNumber) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_ARGUMENT', message: 'Missing tracking number' } });
        }
        shipment.trackingNumber = trackingNumber;
        shipment.updatedAt = nowISO;
      } else if (action === 'RECORD_COD_RECEIVED') {
        // Only CASHIER, DISPATCH_MANAGER, SUPER_ADMIN
        if (!['super_admin', 'dispatch_manager', 'cashier'].includes(req.auth.role)) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only Cashiers or Dispatch Managers can record COD received.' } });
        }
        const recAmt = parseFloat(codReceived || '0');
        shipment.codReceived = recAmt;
        shipment.codPending = Math.max(0, shipment.codExpected - recAmt);
        shipment.codStatus = calculateCodStatus(shipment.codExpected, recAmt, shipment.logisticsStatus);
        shipment.updatedAt = nowISO;
      } else if (action === 'REASSIGN_COURIER') {
        if (!courier) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_ARGUMENT', message: 'Missing courier name' } });
        }
        shipment.courier = courier;
        shipment.updatedAt = nowISO;
      } else if (action === 'RECALCULATE_STATUS') {
        const { lateByCourier, ageHours } = calculateLateByCourier(shipment.courierBookedAt, shipment.courierDeliveredAt, nowISO);
        shipment.lateByCourier = lateByCourier;
        shipment.deliveryAgeHours = ageHours;
        shipment.updatedAt = nowISO;
      }

      await docRef.set(shipment, { merge: true });

      // Create event log
      const event: ShipmentEvent = {
        id: `evt_manual_${id}_${Date.now()}`,
        shipmentId: id,
        eventType: 'MANUAL_OVERRIDE',
        previousStatus: prevStatus,
        newStatus: shipment.logisticsStatus,
        source: 'Manual Dashboard Action',
        performedBy: req.auth.email || req.auth.uid,
        eventTimestamp: nowISO,
        notes: notes || `Action "${action}" performed by ${req.auth.email || req.auth.uid}`
      };
      await db.collection('shipmentEvents').doc(event.id).set(event);

      return res.json({ success: true, data: shipment });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 5. IMPORT FILE (OMS / COURIER / RIDERS)
  router.post('/import', requireAuth, requireRole('super_admin', 'dispatch_manager', 'warehouse_staff'), async (req: any, res: any) => {
    try {
      const { fileType, courierName, csvContent, fileName } = req.body;
      if (!fileType || !csvContent) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_ARGUMENT', message: 'Missing fileType or csvContent' } });
      }

      const jobId = `job_${fileType}_${Date.now()}`;
      const userEmail = req.auth.email || req.auth.uid;
      const nowISO = new Date().toISOString();

      let result: any;
      if (fileType === 'oms') {
        result = parseOmsCsv(csvContent, jobId, userEmail);
      } else {
        const shipmentsSnap = await db.collection('shipments').get();
        const existingShipments: Shipment[] = shipmentsSnap.docs.map(doc => doc.data() as Shipment);

        const mappingsSnap = await db.collection('courierMappings').get();
        const customMappings: CourierMapping[] = mappingsSnap.docs.map(doc => doc.data() as CourierMapping);

        result = reconcileCourierCsv(csvContent, courierName || 'Trax', jobId, userEmail, existingShipments, customMappings);
      }

      // Save ImportJob document
      const importJob: ImportJob = {
        id: jobId,
        fileName: fileName || `${fileType}_import_${Date.now()}.csv`,
        fileType,
        courier: courierName || (fileType === 'oms' ? 'OMS' : 'External Courier'),
        uploadedBy: userEmail,
        uploadedAt: nowISO,
        processingStatus: 'completed',
        totalRows: result.jobStats.totalRows,
        successfulRows: result.jobStats.successfulRows,
        failedRows: result.jobStats.failedRows,
        duplicateRows: result.jobStats.duplicateRows,
        unmatchedRows: result.jobStats.unmatchedRows,
        errorDetails: result.jobStats.errorDetails
      };

      await db.collection('importJobs').doc(jobId).set(importJob);

      // Save shipments in batch
      const batch = db.batch();
      if (fileType === 'oms') {
        result.shipments.forEach((s: Shipment) => {
          batch.set(db.collection('shipments').doc(s.id), s);
        });
      } else {
        result.updatedShipments.forEach((s: Shipment) => {
          batch.set(db.collection('shipments').doc(s.id), s);
        });
      }

      // Save events
      result.events.forEach((evt: ShipmentEvent) => {
        batch.set(db.collection('shipmentEvents').doc(evt.id), evt);
      });

      // Save exceptions
      result.exceptions.forEach((exc: LogisticsException) => {
        batch.set(db.collection('exceptions').doc(exc.id), exc);
      });

      await batch.commit();

      return res.json({
        success: true,
        data: {
          importJob,
          processedCount: fileType === 'oms' ? result.shipments.length : result.updatedShipments.length,
          exceptionsCount: result.exceptions.length
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 6. GET IMPORT JOBS HISTORY
  router.get('/import-jobs', requireAuth, requireRole('super_admin', 'dispatch_manager', 'warehouse_staff', 'management_viewer'), async (req: any, res: any) => {
    try {
      const snap = await db.collection('importJobs').get();
      const jobs: ImportJob[] = snap.docs.map(doc => doc.data() as ImportJob);
      jobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

      return res.json({ success: true, data: jobs });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 7. WAREHOUSE PHYSICAL RETURN RECEIVING (CONFIRM PHYSICAL RETURN)
  router.post('/warehouse/receive-return', requireAuth, requireRole('super_admin', 'dispatch_manager', 'warehouse_staff'), async (req: any, res: any) => {
    try {
      const { trackingNumber, location, condition, disposition, quantityExpected, quantityReceived, remarks, photoUrls } = req.body;

      if (!trackingNumber || !condition || !disposition) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_ARGUMENT', message: 'Missing tracking number, condition, or disposition.' }
        });
      }

      // Find matching shipment by tracking or order number
      const shipmentsSnap = await db.collection('shipments').get();
      const shipmentDoc = shipmentsSnap.docs.find(doc => {
        const data = doc.data() as Shipment;
        return data.trackingNumber.toUpperCase() === trackingNumber.trim().toUpperCase() ||
               data.orderNumber.toUpperCase() === trackingNumber.trim().toUpperCase();
      });

      if (!shipmentDoc) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Shipment with tracking/order ${trackingNumber} not found.` }
        });
      }

      const shipment = shipmentDoc.data() as Shipment;

      // CRITICAL SECURITY RULE: Prevent double confirmation!
      if (shipment.physicalReturnReceived === true || shipment.logisticsStatus === 'RETURN_PHYSICALLY_RECEIVED') {
        return res.status(400).json({
          success: false,
          error: { code: 'DUPLICATE_RECEIPT', message: `Physical return for tracking ${trackingNumber} has already been received and confirmed.` }
        });
      }

      const nowISO = new Date().toISOString();
      const prevStatus = shipment.logisticsStatus;

      // Update Shipment document
      shipment.physicalReturnReceived = true;
      shipment.physicalReturnReceivedAt = nowISO;
      shipment.physicalReturnReceivedBy = req.auth.email || req.auth.uid;
      shipment.physicalReturnLocation = location || 'Main Warehouse - Bin R-1';
      shipment.returnCondition = condition as ReturnCondition;
      shipment.returnDisposition = disposition as ReturnDisposition;
      shipment.returnQuantityExpected = parseInt(quantityExpected || '1', 10);
      shipment.returnQuantityReceived = parseInt(quantityReceived || '1', 10);
      shipment.returnNotes = remarks || '';
      shipment.logisticsStatus = 'RETURN_PHYSICALLY_RECEIVED';
      shipment.updatedAt = nowISO;

      // Create PhysicalReturnRecord document
      const returnRecord: PhysicalReturnRecord = {
        id: `ret_${shipment.id}_${Date.now()}`,
        shipmentId: shipment.id,
        trackingNumber: shipment.trackingNumber,
        orderNumber: shipment.orderNumber,
        receivedBy: req.auth.email || req.auth.uid,
        receivedByUid: req.auth.uid,
        receivedAt: nowISO,
        location: shipment.physicalReturnLocation,
        condition: shipment.returnCondition,
        disposition: shipment.returnDisposition,
        quantityExpected: shipment.returnQuantityExpected,
        quantityReceived: shipment.returnQuantityReceived,
        remarks: remarks || '',
        photoUrls: photoUrls || []
      };

      // Create Timeline Event
      const event: ShipmentEvent = {
        id: `evt_phys_ret_${shipment.id}_${Date.now()}`,
        shipmentId: shipment.id,
        eventType: 'PHYSICAL_RETURN',
        previousStatus: prevStatus,
        newStatus: 'RETURN_PHYSICALLY_RECEIVED',
        source: 'Warehouse Physical Receipt Scan',
        performedBy: req.auth.email || req.auth.uid,
        eventTimestamp: nowISO,
        notes: `Physical return received at ${shipment.physicalReturnLocation}. Condition: ${condition}, Disposition: ${disposition}`
      };

      const batch = db.batch();
      batch.set(db.collection('shipments').doc(shipment.id), shipment);
      batch.set(db.collection('physicalReturns').doc(returnRecord.id), returnRecord);
      batch.set(db.collection('shipmentEvents').doc(event.id), event);
      await batch.commit();

      return res.json({
        success: true,
        data: {
          shipment,
          returnRecord
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 8. GET & RESOLVE LOGISTICS EXCEPTIONS
  router.get('/exceptions', requireAuth, requireRole('super_admin', 'dispatch_manager', 'customer_service', 'warehouse_staff', 'management_viewer'), async (req: any, res: any) => {
    try {
      const snap = await db.collection('exceptions').get();
      const list: LogisticsException[] = snap.docs.map(doc => doc.data() as LogisticsException);
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  router.post('/exceptions/:id/resolve', requireAuth, requireRole('super_admin', 'dispatch_manager', 'customer_service', 'warehouse_staff'), async (req: any, res: any) => {
    try {
      const { id } = req.params;
      const { resolutionNotes } = req.body;

      const docRef = db.collection('exceptions').doc(id);
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Exception not found' } });
      }

      const exc = docSnap.data() as LogisticsException;
      const nowISO = new Date().toISOString();
      exc.status = 'RESOLVED';
      exc.resolutionNotes = resolutionNotes || 'Resolved by operator';
      exc.resolvedBy = req.auth.email || req.auth.uid;
      exc.resolvedAt = nowISO;

      await docRef.set(exc, { merge: true });

      return res.json({ success: true, data: exc });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 9. COURIER PERFORMANCE REPORTING
  router.get('/reports/courier-performance', requireAuth, requireRole('super_admin', 'dispatch_manager', 'management_viewer'), async (req: any, res: any) => {
    try {
      const shipmentsSnap = await db.collection('shipments').get();
      const shipments: Shipment[] = shipmentsSnap.docs.map(doc => doc.data() as Shipment);

      const exceptionsSnap = await db.collection('exceptions').get();
      const exceptions: LogisticsException[] = exceptionsSnap.docs.map(doc => doc.data() as LogisticsException);

      const metrics = calculateCourierPerformance(shipments, exceptions);

      return res.json({ success: true, data: metrics });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  // 10. COURIER MAPPINGS
  router.get('/courier-mappings', requireAuth, requireRole('super_admin', 'dispatch_manager', 'management_viewer'), async (req: any, res: any) => {
    try {
      const snap = await db.collection('courierMappings').get();
      const list: CourierMapping[] = snap.docs.map(doc => doc.data() as CourierMapping);
      return res.json({ success: true, data: list });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  router.post('/courier-mappings', requireAuth, requireRole('super_admin', 'dispatch_manager'), async (req: any, res: any) => {
    try {
      const { courier, courierStatusRaw, logisticsStatus, description } = req.body;
      if (!courier || !courierStatusRaw || !logisticsStatus) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_ARGUMENT', message: 'Missing courier, courierStatusRaw, or logisticsStatus' } });
      }

      const id = `map_${courier.toLowerCase()}_${courierStatusRaw.toLowerCase().replace(/\s+/g, '_')}`;
      const mapping: CourierMapping = {
        id,
        courier,
        courierStatusRaw,
        logisticsStatus,
        description: description || '',
        updatedAt: new Date().toISOString()
      };

      await db.collection('courierMappings').doc(id).set(mapping);
      return res.json({ success: true, data: mapping });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });

  return router;
}
