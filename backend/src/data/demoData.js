const isoMinutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

export const demoState = {
  users: [
    {
      id: 'usr-central',
      email: 'central@transrent.demo',
      password: 'demo123',
      name: 'Admin Pusat',
      role: 'CENTRAL_ADMIN',
      companyId: null,
      branchId: null,
      verificationStatus: 'VERIFIED',
      ktpDocument: null,
      simDocument: null
    },
    {
      id: 'usr-admin-bali',
      email: 'admin@balimove.demo',
      password: 'demo123',
      name: 'Ayu Pratama',
      role: 'RENTAL_ADMIN',
      companyId: 'company-balimove',
      branchId: null,
      verificationStatus: 'VERIFIED'
    },
    {
      id: 'usr-staff-bali',
      email: 'staff@balimove.demo',
      password: 'demo123',
      name: 'Made Staff',
      role: 'STAFF',
      companyId: 'company-balimove',
      branchId: null,
      verificationStatus: 'VERIFIED'
    },
    {
      id: 'usr-customer',
      email: 'customer@transrent.demo',
      password: 'demo123',
      name: 'Jeremy Customer',
      role: 'CUSTOMER',
      companyId: null,
      branchId: null,
      verificationStatus: 'VERIFIED',
      phone: '081234567890',
      address: 'Denpasar, Bali',
      ktpNumber: '5171********0001',
      simNumber: 'B****0001',
      ktpDocument: 'demo-ktp.jpg',
      simDocument: 'demo-sim.jpg'
    },
    {
      id: 'usr-pending',
      email: 'pending@transrent.demo',
      password: 'demo123',
      name: 'Customer Pending',
      role: 'CUSTOMER',
      companyId: null,
      branchId: null,
      verificationStatus: 'PENDING',
      phone: '081200000000',
      address: 'Badung, Bali',
      ktpNumber: '5171********0020',
      simNumber: 'B****0020',
      ktpDocument: 'pending-ktp.jpg',
      simDocument: 'pending-sim.jpg'
    }
  ],
  companies: [
    {
      id: 'company-balimove',
      name: 'BaliMove Rental',
      legalName: 'PT BaliMove Transportasi',
      phone: '0812-3000-1000',
      email: 'hello@balimove.demo',
      status: 'ACTIVE',
      description: 'Rental mobil dan motor untuk perjalanan Bali.',
      deliveryRadiusKm: 15,
      gpsAgreementStatus: 'ACTIVE',
      gpsTrackingAllowed: true,
      gpsAgreementNumber: 'MOU-GPS-DEMO-BALIMOVE'
    },
    {
      id: 'company-islandmotion',
      name: 'IslandMotion',
      legalName: 'CV IslandMotion Nusantara',
      phone: '0812-3000-2000',
      email: 'hello@islandmotion.demo',
      status: 'ACTIVE',
      description: 'Pilihan kendaraan praktis di area Denpasar dan sekitarnya.',
      deliveryRadiusKm: 15,
      gpsAgreementStatus: 'ACTIVE',
      gpsTrackingAllowed: true,
      gpsAgreementNumber: 'MOU-GPS-DEMO-ISLANDMOTION'
    }
  ],
  agreements: [
    {
      id: 'agr-balimove',
      companyId: 'company-balimove',
      agreementNumber: 'MOU-GPS-DEMO-BALIMOVE',
      status: 'ACTIVE',
      gpsTrackingAllowed: true,
      signedAt: isoMinutesFromNow(-2400),
      expiresAt: null,
      notes: 'Agreement dummy untuk demo.'
    },
    {
      id: 'agr-islandmotion',
      companyId: 'company-islandmotion',
      agreementNumber: 'MOU-GPS-DEMO-ISLANDMOTION',
      status: 'ACTIVE',
      gpsTrackingAllowed: true,
      signedAt: isoMinutesFromNow(-2400),
      expiresAt: null,
      notes: 'Agreement dummy untuk demo.'
    }
  ],
  branches: [
    {
      id: 'branch-kuta',
      companyId: 'company-balimove',
      name: 'BaliMove Kuta',
      address: 'Jl. Sunset Road No. 88, Kuta',
      latitude: -8.7179,
      longitude: 115.1682,
      phone: '0812-3000-1001'
    },
    {
      id: 'branch-sanur',
      companyId: 'company-balimove',
      name: 'BaliMove Sanur',
      address: 'Jl. Danau Tamblingan No. 15, Sanur',
      latitude: -8.6884,
      longitude: 115.2631,
      phone: '0812-3000-1002'
    },
    {
      id: 'branch-seminyak',
      companyId: 'company-islandmotion',
      name: 'IslandMotion Seminyak',
      address: 'Jl. Raya Seminyak No. 21, Seminyak',
      latitude: -8.6913,
      longitude: 115.1681,
      phone: '0812-3000-2001'
    }
  ],
  vehicles: [
    {
      id: 'veh-avanza',
      companyId: 'company-balimove',
      branchId: 'branch-kuta',
      name: 'Toyota Avanza G',
      type: 'CAR',
      transmission: 'Automatic',
      seats: 7,
      year: 2023,
      plateNumber: 'DK 1782 TR',
      pricePerDay: 450000,
      deposit: 500000,
      status: 'AVAILABLE',
      gpsStatus: 'READY',
      gpsDeviceId: 'GPS-AVANZA-01',
      image: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'
    },
    {
      id: 'veh-vario',
      companyId: 'company-balimove',
      branchId: 'branch-kuta',
      name: 'Honda Vario 160',
      type: 'MOTORCYCLE',
      transmission: 'Automatic',
      seats: 2,
      year: 2024,
      plateNumber: 'DK 4218 TR',
      pricePerDay: 130000,
      deposit: 250000,
      status: 'AVAILABLE',
      gpsStatus: 'READY',
      gpsDeviceId: 'GPS-VARIO-01',
      image: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'
    },
    {
      id: 'veh-innova',
      companyId: 'company-balimove',
      branchId: 'branch-sanur',
      name: 'Toyota Innova Reborn',
      type: 'CAR',
      transmission: 'Automatic',
      seats: 7,
      year: 2022,
      plateNumber: 'DK 8831 TR',
      pricePerDay: 650000,
      deposit: 750000,
      status: 'AVAILABLE',
      gpsStatus: 'READY',
      gpsDeviceId: 'GPS-INNOVA-01',
      image: 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=900&q=80'
    },
    {
      id: 'veh-nmax',
      companyId: 'company-islandmotion',
      branchId: 'branch-seminyak',
      name: 'Yamaha NMAX Connected',
      type: 'MOTORCYCLE',
      transmission: 'Automatic',
      seats: 2,
      year: 2023,
      plateNumber: 'DK 9920 IM',
      pricePerDay: 180000,
      deposit: 300000,
      status: 'AVAILABLE',
      gpsStatus: 'READY',
      gpsDeviceId: 'GPS-NMAX-01',
      image: 'https://images.unsplash.com/photo-1568772585407-9361f9bf3a87?auto=format&fit=crop&w=900&q=80'
    },
    {
      id: 'veh-faulty',
      companyId: 'company-islandmotion',
      branchId: 'branch-seminyak',
      name: 'Toyota Agya',
      type: 'CAR',
      transmission: 'Manual',
      seats: 5,
      year: 2021,
      plateNumber: 'DK 2190 IM',
      pricePerDay: 320000,
      deposit: 400000,
      status: 'MAINTENANCE',
      gpsStatus: 'FAULTY',
      gpsDeviceId: 'GPS-AGYA-01',
      image: 'https://images.unsplash.com/photo-1502877338535-766e1452684a?auto=format&fit=crop&w=900&q=80'
    }
  ],
  reservations: [],
  payments: [],
  rentals: [],
  inspections: [],
  fines: [],
  disputes: [],
  refunds: [],
  maintenances: [
    {
      id: 'mnt-001',
      vehicleId: 'veh-faulty',
      type: 'GPS_REPAIR',
      title: 'Perbaikan GPS device',
      status: 'IN_PROGRESS',
      scheduledAt: isoMinutesFromNow(-180),
      notes: 'Kendaraan tidak dapat dipesan sampai GPS kembali READY.'
    }
  ],
  locations: [],
  notificationLog: []
};
