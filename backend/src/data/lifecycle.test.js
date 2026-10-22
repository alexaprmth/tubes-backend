import '../testing-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { demoState } from './demoData.js';
import { createReservation, simulatePayment, handover, returnRental, confirmRefund, createMaintenance, listRentals, listLocations, rentalDays, submitDispute, cancelReservation, resolveDispute, simulateFinePayment, completeMaintenance, cancelMaintenance } from './store.js';

const initial = structuredClone(demoState);
const customer = initial.users.find((u) => u.role === 'CUSTOMER' && u.verificationStatus === 'VERIFIED');
const admin = initial.users.find((u) => u.role === 'RENTAL_ADMIN');
const vehicle = initial.vehicles.find((v) => v.companyId === admin.companyId && v.status === 'AVAILABLE' && v.gpsStatus === 'READY');
const reset = () => Object.assign(demoState, structuredClone(initial));
const reserve = () => createReservation(customer, { vehicleId: vehicle.id, startDate: '2027-01-01', endDate: '2027-01-04' });
const active = () => { const reservation = reserve(); simulatePayment(customer, reservation.id); return handover(admin, reservation.id).rental; };

test('rejects impossible and malformed dates', () => {
  reset();
  for (const date of ['2027-02-30', 'not-a-date', '2027-1-01']) assert.throws(() => rentalDays(date, '2027-03-01'), { status: 400 });
  assert.equal(demoState.reservations.length, initial.reservations.length);
});
test('payment retry is idempotent', () => {
  reset(); const reservation = reserve();
  const first = simulatePayment(customer, reservation.id);
  const second = simulatePayment(customer, reservation.id);
  assert.equal(first.payment.id, second.payment.id);
  assert.equal(demoState.payments.filter((p) => p.reservationId === reservation.id).length, 1);
});
test('refund cannot complete an active rental; maintenance cannot overwrite it', () => {
  reset(); const rental = active();
  assert.throws(() => confirmRefund(admin, rental.id), { status: 409 });
  assert.throws(() => createMaintenance(admin, { vehicleId: vehicle.id }), { status: 409 });
  assert.equal(rental.status, 'ACTIVE');
  assert.equal(demoState.vehicles.find((v) => v.id === vehicle.id).status, 'RENTED');
});
test('negative, NaN and fractional damage rejected before inspection writes', () => {
  reset(); const rental = active(); const before = demoState.inspections.length;
  for (const amount of [-1, NaN, Infinity, '10', 1.5]) assert.throws(() => returnRental(admin, rental.id, { damageItems: [{ amount }] }), { status: 400 });
  assert.equal(demoState.inspections.length, before);
  assert.equal(rental.status, 'ACTIVE');
  assert.throws(() => returnRental(admin, rental.id, { staffPhotos: ['inspections/another-company.jpg'] }), { status: 400 });
  assert.equal(demoState.inspections.length, before);
});
test('one late day charged; damaged vehicle remains unavailable; refund retry safe', () => {
  reset(); const rental = active();
  const result = returnRental(admin, rental.id, { actualReturnDate: '2027-01-05', damageItems: [{ amount: 10000 }] });
  assert.equal(result.fine.lateDays, 1);
  assert.equal(result.fine.total, 10000 + Math.round(vehicle.pricePerDay * 0.25));
  confirmRefund(admin, rental.id);
  assert.equal(demoState.vehicles.find((v) => v.id === vehicle.id).status, 'MAINTENANCE');
  demoState.vehicles.find((v) => v.id === vehicle.id).status = 'RENTED';
  confirmRefund(admin, rental.id);
  assert.equal(demoState.vehicles.find((v) => v.id === vehicle.id).status, 'RENTED');
  assert.equal(demoState.reservations.find((s) => s.id === rental.reservationId).status, 'COMPLETED');
});
test('operational customer omits identity and GPS history excludes previous rental', async () => {
  reset(); const rental = active();
  demoState.locations.push({ id: 'old', vehicleId: vehicle.id, rentalId: 'old-rental', recordedAt: '2027-01-02' });
  demoState.locations.push({ id: 'current', vehicleId: vehicle.id, rentalId: rental.id, recordedAt: '2027-01-01' });
  const listed = listRentals(admin).find((r) => r.id === rental.id);
  assert.equal(listed.customer.ktpNumber, undefined);
  assert.equal(listed.customer.simDocument, undefined);
  assert.equal(listed.latestLocation.id, 'current');
  assert.deepEqual((await listLocations(customer, vehicle.id)).map((p) => p.id), ['current']);
});
test('second handover on same vehicle is rejected even for nonoverlapping bookings', () => {
  reset(); const first = reserve();
  const second = createReservation(customer, { vehicleId: vehicle.id, startDate: '2027-02-01', endDate: '2027-02-04' });
  simulatePayment(customer, first.id); simulatePayment(customer, second.id);
  handover(admin, first.id);
  assert.throws(() => handover(admin, second.id), { status: 409 });
});
test('open dispute blocks refund and an invalid dispute leaves fine unchanged', () => {
  reset(); const rental = active();
  returnRental(admin, rental.id, { damageItems: [{ amount: 10000 }] });
  const fine = demoState.fines.find((f) => f.rentalId === rental.id);
  assert.throws(() => submitDispute(customer, fine.id, { reason: '' }), { status: 400 });
  assert.equal(fine.status, 'ISSUED');
  submitDispute(customer, fine.id, { reason: 'Synthetic reason' });
  assert.throws(() => confirmRefund(admin, rental.id), { status: 409 });
  assert.equal(rental.status, 'RETURN_PENDING_REVIEW');
});

test('new payment rechecks current verification and MoU; cancellation refunds once before handover', async () => {
  reset(); let reservation = reserve();
  const user = demoState.users.find((u) => u.id === customer.id);
  user.verificationStatus = 'REJECTED';
  assert.throws(() => simulatePayment(customer, reservation.id), { status: 403 });
  user.verificationStatus = 'VERIFIED';
  const mou = demoState.agreements.find((a) => a.companyId === vehicle.companyId);
  mou.status = 'REVOKED'; assert.throws(() => simulatePayment(customer, reservation.id), { status: 409 });
  mou.status = 'ACTIVE';
  const payment = simulatePayment(customer, reservation.id).payment;
  await assert.rejects(() => cancelReservation(customer, reservation.id, null), { status: 400 });
  const result = await cancelReservation(customer, reservation.id, { reason: 'Synthetic cancellation' });
  assert.equal(result.reservation.cancellation.refundAmount, reservation.totalAmount);
  assert.equal(payment.status, 'REFUNDED');
  assert.equal((await cancelReservation(customer, reservation.id, { reason: 'Synthetic cancellation' })).reservation.cancellation.id, result.reservation.cancellation.id);
  assert.throws(() => simulatePayment(customer, reservation.id), { status: 409 });
  assert.throws(() => handover(admin, reservation.id), { status: 409 });
  reservation = reserve();
  const unpaid = await cancelReservation(admin, reservation.id, { reason: 'Synthetic unpaid' });
  assert.equal(unpaid.reservation.cancellation.refundAmount, 0);
  assert.equal(unpaid.reservation.cancellation.refundStatus, 'NOT_REQUIRED');
  const rental = active();
  await assert.rejects(() => cancelReservation(customer, rental.reservationId, { reason: 'Too late' }), { status: 409 });
});

test('dispute decision recalculates deposit, extra fine payment is scoped/idempotent and blocks premature closure', async () => {
  reset(); const rental = active();
  const reservation = demoState.reservations.find((s) => s.id === rental.reservationId);
  returnRental(admin, rental.id, { damageItems: [{ amount: reservation.depositAmount + 300000 }] });
  const fine = demoState.fines.find((f) => f.rentalId === rental.id);
  assert.throws(() => confirmRefund(admin, rental.id), { status: 409 });
  const dispute = submitDispute(customer, fine.id, { reason: 'Synthetic dispute' });
  await assert.rejects(() => simulateFinePayment(customer, rental.id), { status: 409 });
  await assert.rejects(() => resolveDispute(customer, dispute.id, { decision: 'ACCEPTED', notes: 'No access' }), { status: 403 });
  await assert.rejects(() => resolveDispute({ ...admin, companyId: 'other' }, dispute.id, { decision: 'ACCEPTED', notes: 'No access' }), { status: 403 });
  await assert.rejects(() => resolveDispute(admin, dispute.id, { decision: 'ADJUSTED', amount: fine.amount + 1, notes: 'Invalid' }), { status: 400 });
  const decision = { decision: 'ADJUSTED', amount: reservation.depositAmount + 100000, notes: 'Synthetic correction' };
  await resolveDispute(admin, dispute.id, decision);
  assert.equal(dispute.originalAmount, reservation.depositAmount + 300000);
  assert.equal(dispute.resolvedBy, admin.id);
  await resolveDispute(admin, dispute.id, decision);
  await assert.rejects(() => resolveDispute(admin, dispute.id, { decision: 'ACCEPTED', notes: 'Overwrite' }), { status: 409 });
  assert.equal(listRentals(customer).find((r) => r.id === rental.id).settlement.balanceDue, 100000);
  await assert.rejects(() => simulateFinePayment({ ...customer, id: 'other' }, rental.id), { status: 404 });
  const first = await simulateFinePayment(customer, rental.id);
  assert.equal(first.payment.amount, 100000);
  assert.equal((await simulateFinePayment(customer, rental.id)).payment.id, first.payment.id);
  assert.throws(() => submitDispute(customer, fine.id, { reason: 'After payment' }), { status: 409 });
  confirmRefund(admin, rental.id);
  assert.equal(rental.status, 'COMPLETED');
  const actualVehicle = demoState.vehicles.find((v) => v.id === vehicle.id);
  const cancelled = createMaintenance(admin, { vehicleId: vehicle.id, type: 'REPAIR' });
  cancelMaintenance(admin, cancelled.id); assert.equal(actualVehicle.status, 'MAINTENANCE');
  const firstRepair = createMaintenance(admin, { vehicleId: vehicle.id, type: 'REPAIR' });
  const unfinishedRepair = createMaintenance(admin, { vehicleId: vehicle.id, type: 'REPAIR' });
  completeMaintenance(admin, firstRepair.id); cancelMaintenance(admin, unfinishedRepair.id);
  assert.equal(actualVehicle.status, 'MAINTENANCE'); assert.equal(actualVehicle.repairRequired, true);
  const service = createMaintenance(admin, { vehicleId: vehicle.id, type: 'SERVICE' });
  completeMaintenance(admin, service.id); assert.equal(actualVehicle.status, 'MAINTENANCE');
  const repaired = createMaintenance(admin, { vehicleId: vehicle.id, type: 'REPAIR' });
  completeMaintenance(admin, repaired.id); assert.equal(actualVehicle.status, 'AVAILABLE');
  assert.equal(actualVehicle.repairRequired, false);
});

test('accepted dispute waives fine and restores full deposit but does not repair physical damage', async () => {
  reset(); const rental = active(); returnRental(admin, rental.id, { damageItems: [{ amount: 10000 }] });
  const fine = demoState.fines.find((f) => f.rentalId === rental.id);
  const dispute = submitDispute(customer, fine.id, { reason: 'Not customer liability' });
  const central = initial.users.find((u) => u.role === 'CENTRAL_ADMIN');
  await resolveDispute(central, dispute.id, { decision: 'ACCEPTED', notes: 'Evidence reviewed' });
  assert.equal(fine.amount, 0); assert.equal(fine.status, 'CANCELLED');
  const result = confirmRefund(admin, rental.id);
  assert.equal(result.refund.amount, demoState.reservations.find((s) => s.id === rental.reservationId).depositAmount);
  assert.equal(demoState.vehicles.find((v) => v.id === vehicle.id).status, 'MAINTENANCE');
});
