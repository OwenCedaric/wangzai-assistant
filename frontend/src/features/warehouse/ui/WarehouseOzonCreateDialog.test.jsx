import { describe, expect, it } from 'vitest';

import { buildWarehouseCreateWrite } from './WarehouseOzonCreateDialog.jsx';

const base = {
  name: '测试仓', phone: '+86 188 0000 0000', latitude: '29.3', longitude: '120.1',
  isAutoAssembly: true, minOrderValue: '100', workDays: ['MONDAY', 'TUESDAY'],
  workFrom: '09:00', workTo: '18:00', deliveryName: '测试配送', cutIn: '120',
  courierCutoff: '15', courierComment: '备注', courierPhones: '+86 188 0000 0000',
  deliverToPvz: true, deliveryMinAmount: '10', deliveryMaxAmount: '50', deliveryPercent: '5',
  returnMethod: 'COURIER', returnContactDays: '3', returnZipcode: '322000', transportCompanyName: '',
  polygonIds: '101, 102', polygonTime: '60', countryCode: 'CN', isKgt: false,
  firstMileType: 'DROP_OFF', dropOffPointId: '201', timeslotId: '301', returnPointId: '401',
};

describe('buildWarehouseCreateWrite', () => {
  it('builds an FBS warehouse request with selected points and working days', () => {
    expect(buildWarehouseCreateWrite({ ...base, mode: 'fbs' })).toMatchObject({
      action: 'warehouse.create.fbs', endpointKey: 'warehouse.fbsCreate',
      payload: {
        address_coordinates: { latitude: 29.3, longitude: 120.1 },
        first_mile_type: 'DROP_OFF', drop_off_point_id: 201, timeslot_id: 301,
        return_point_id: 401, working_days: ['MONDAY', 'TUESDAY'],
      },
    });
  });

  it('creates an Ozon-partner rFBS warehouse and delivery method together', () => {
    expect(buildWarehouseCreateWrite({ ...base, mode: 'erfbs-aggregator' })).toMatchObject({
      action: 'warehouse.create.erfbs-aggregator',
      endpointKey: 'warehouse.erfbsAggregatorCreate',
      payload: {
        name: '测试仓',
        delivery_method: {
          name: '测试配送', cut_in: 120, deliver_to_pvz: true,
          delivery_costs: { min_amount: 10, max_amount: 50, percent: 5 },
          return_settings: { return_method: 'COURIER', contact_days: 3 },
        },
      },
    });
  });

  it('creates a non-integrated rFBS warehouse with selected polygons', () => {
    expect(buildWarehouseCreateWrite({ ...base, mode: 'erfbs-non-integrated' })).toMatchObject({
      action: 'warehouse.create.erfbs-non-integrated',
      endpointKey: 'warehouse.erfbsNonIntegratedCreate',
      payload: {
        delivery_method: {
          name: '测试配送', cut_in: 120, courier_cutoff: 15,
          delivery_polygons: [{ id: 101, time: 60 }, { id: 102, time: 60 }],
        },
      },
    });
  });
});
