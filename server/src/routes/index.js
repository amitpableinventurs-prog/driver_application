import auth from './auth.js';
import common from './common.js';
import customer from './customer.js';
import driver from './driver.js';
import adminCore from './admin-core.js';
import adminPeople from './admin-people.js';
import adminOps from './admin-ops.js';
import adminContent from './admin-content.js';

export const API_BASE = '/api/v1';
export const apis = [auth, common, customer, driver, adminCore, adminPeople, adminOps, adminContent];
