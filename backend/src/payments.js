import dotenv from 'dotenv';

dotenv.config();

const configuredProvider = (process.env.PAYMENT_PROVIDER || 'SIMULATED_GATEWAY').toUpperCase();

export const paymentProvider = configuredProvider;

/**
 * Payment port untuk menjaga flow reservation tidak bergantung pada vendor.
 * Saat ini hanya simulator yang aktif; adapter Midtrans dapat ditambahkan
 * kemudian tanpa mengubah endpoint reservation/handover.
 */
export const createPaymentRecord = ({ reservationId, amount }) => {
  if (configuredProvider !== 'SIMULATED_GATEWAY') {
    const error = new Error(
      `Payment provider '${configuredProvider}' belum diaktifkan. Gunakan PAYMENT_PROVIDER=SIMULATED_GATEWAY untuk demo.`
    );
    error.status = 501;
    error.code = 'PAYMENT_PROVIDER_NOT_IMPLEMENTED';
    throw error;
  }

  const paidAt = new Date().toISOString();
  return {
    reservation_id: reservationId,
    provider: 'SIMULATED_GATEWAY',
    provider_reference: `SIM-${Date.now()}`,
    amount,
    status: 'PAID',
    paid_at: paidAt,
    paidAt
  };
};

