const axios = require('axios');
const fs = require('fs');
const path = require('path');

const VERSION = 'HCC_TTHC_CRAWLER_1.0.0';
const DATA_DIR = path.join(process.cwd(), 'data');
const DETAILS_DIR = path.join(DATA_DIR, 'details');
const LIST_URL = 'https://dichvucong.gov.vn/api/v1/submitting/formality/list-all-public-formality-by-citizen';
const DETAIL_URL = 'https://dichvucong.gov.vn/api/v1/configuring/formality/get-formality-by-citizen';
const PAGE_LIMIT = 200;
const DETAIL_CHUNK = 20;

const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'HCC-TTHC-Data/1.0 (+public DVCQG catalog sync)'
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function postWithRetry(url, payload, maxRetries = 5) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await axios.post(url, payload, { headers, timeout: 45000 });
      return res.data;
    } catch (err) {
      lastError = err;
      if (i >= maxRetries) break;
      const wait = Math.min(30000, 1000 * Math.pow(2, i));
      console.log(`⚠️ Lỗi gọi API, thử lại ${i + 1}/${maxRetries} sau ${wait}ms: ${err.message}`);
      await delay(wait);
    }
  }
  throw lastError;
}

function sanitizeBase64(obj) {
  let s = JSON.stringify(obj);
  s = s.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/g, '[Hình ảnh đính kèm trên DVCQG]');
  return JSON.parse(s);
}

function text(v) {
  return v == null ? '' : String(v).trim();
}

function parseFormalityType(type) {
  if (type === 'ASSIGNED_REGULATION') return 'TTHC được luật giao quy định chi tiết';
  if (type === 'SPECIFIC') return 'TTHC Đặc thù';
  if (type === 'STANDARD') return 'TTHC Tiêu chuẩn';
  if (type === 'INTERCONNECTED') return 'TTHC liên thông';
  if (type === 'STANDARD_INTERNAL') return 'TTHC nội bộ';
  if (type === 'INTERCONNECTED_INTERNAL') return 'TTHC nội bộ liên thông';
  return type || 'Không xác định';
}

function parseCaseLevel(detail) {
  const levels = [];
  if (detail?.isWard === true) levels.push('Cấp xã');
  if (detail?.isProvince === true) levels.push('Cấp tỉnh');
  if (detail?.isMinistry === true) levels.push('Cấp Bộ');
  if (detail?.isOtherAgency === true) levels.push('Cơ quan khác');
  return levels.length ? levels.join(', ') : 'Chưa xác định';
}

function normalizeExecutingAgencies(detail, item) {
  const v = detail?.executingAgencies;
  if (Array.isArray(v)) {
    return v.map(x => typeof x === 'string' ? x : (x?.name || x?.agencyName || x?.title || '')).filter(Boolean).join(', ');
  }
  if (typeof v === 'string') return v;
  if (Array.isArray(item?.departments)) return item.departments.join(', ');
  return '';
}

function qualityState(item, detail) {
  if (!item || !detail) return 'INVALID';
  const missing = [];
  if (!text(item.code)) missing.push('ma_tthc');
  if (!text(item.name)) missing.push('ten_tthc');
  if (!Array.isArray(detail.executionSteps) || detail.executionSteps.length === 0) missing.push('executionSteps');
  if (!Array.isArray(detail.profileComponents) || detail.profileComponents.length === 0) missing.push('profileComponents');
  if (!Array.isArray(detail.executionMethods) || detail.executionMethods.length === 0) missing.push('executionMethods');
  return missing.length ? 'UNKNOWN' : 'KNOWN';
}

async function fetchCatalog() {
  const items = [];
  let lastId = '';
  let page = 0;
  while (true) {
    page++;
    const payload = { limit: PAGE_LIMIT, lastId, q: '', categoryId: '', departmentCode: '' };
    const res = await postWithRetry(LIST_URL, payload);
    const batch = res?.data?.items;
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    console.log(`📚 Trang ${page}: +${batch.length}, tổng ${items.length}`);
    const next = text(res?.data?.lastId);
    if (!next || next === lastId) break;
    lastId = next;
    await delay(120);
  }
  return items;
}

async function main() {
  console.log(`=== ${VERSION} ===`);
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DETAILS_DIR, { recursive: true });

  const rawList = await fetchCatalog();
  console.log(`✅ Tổng danh mục: ${rawList.length}`);

  const index = [];
  const errors = [];

  for (let i = 0; i < rawList.length; i += DETAIL_CHUNK) {
    const chunk = rawList.slice(i, i + DETAIL_CHUNK);
    const results = await Promise.all(chunk.map(async item => {
      try {
        const res = await postWithRetry(DETAIL_URL, { id: item.id });
        const detail = res?.data?.data || res?.data;
        if (!detail || typeof detail !== 'object') throw new Error('Không có detail hợp lệ');

        const cleanDetail = sanitizeBase64(detail);
        fs.writeFileSync(path.join(DETAILS_DIR, `${item.id}.json`), JSON.stringify(cleanDetail));

        return {
          id: item.id,
          ma_tthc: text(item.code),
          ten_tthc: text(item.name),
          cap_thuc_hien: parseCaseLevel(detail),
          loai_tthc: parseFormalityType(item.type || detail.formalityType),
          linh_vuc: Array.isArray(item.categories) ? item.categories.join(', ') : '',
          co_quan_thuc_hien: normalizeExecutingAgencies(detail, item),
          data_state: qualityState(item, detail)
        };
      } catch (err) {
        errors.push({ id: item?.id, code: item?.code, name: item?.name, error: err.message });
        return null;
      }
    }));

    index.push(...results.filter(Boolean));
    console.log(`⚙️ Chi tiết: ${Math.min(i + DETAIL_CHUNK, rawList.length)}/${rawList.length} | thành công ${index.length} | lỗi ${errors.length}`);
    await delay(180);
  }

  index.sort((a, b) => a.ma_tthc.localeCompare(b.ma_tthc, 'vi'));

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(DATA_DIR, 'version.json'), JSON.stringify({
    crawler_version: VERSION,
    last_updated: now,
    source: 'Cổng DVC Quốc gia - API công khai dành cho công dân',
    list_endpoint: LIST_URL,
    detail_endpoint: DETAIL_URL,
    total_catalog: rawList.length,
    total_records: index.length,
    total_errors: errors.length
  }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'errors.json'), JSON.stringify(errors, null, 2));

  console.log(`🎉 Hoàn tất: ${index.length}/${rawList.length}; lỗi ${errors.length}`);
  if (rawList.length === 0 || index.length < Math.max(1, Math.floor(rawList.length * 0.9))) {
    throw new Error('Tỷ lệ dữ liệu thành công quá thấp; không xuất bản kho dữ liệu không đầy đủ.');
  }
}

main().catch(err => {
  console.error('❌ CRAWL FAILED:', err?.stack || err);
  process.exit(1);
});
