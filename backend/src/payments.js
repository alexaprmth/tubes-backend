import dotenv from 'dotenv';

dotenv.config();

const configuredProvider = process.env.PAYMENT_MODE === 'LEGACY_SIMULATION' ? 'SIMULATED_GATEWAY' : 'INTERNAL_MANUAL';

export const paymentProvider = configuredProvider;

/**
 * Payment port untuk menjaga flow reservation tidak bergantung pada vendor.
 * Saat ini checkout internal memerlukan persetujuan admin; adapter Midtrans dapat ditambahkan
 * kemudian tanpa mengubah endpoint reservation/handover.
 */
export const createPaymentRecord = ({ reservationId, amount }) => {
  if (configuredProvider !== 'SIMULATED_GATEWAY') {
    const error = new Error(
      `Payment provider '${configuredProvider}' belum diaktifkan. Gunakan checkout internal dan konfirmasi admin.`
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

