'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Chế độ TEST an toàn (whitelist SĐT) — CÓ THỂ chỉnh runtime qua UI thay vì sửa .env + restart.
 *
 *   - testMode   : bật thì bot CHỈ gửi thật tới số trong testPhones, mọi số khác bị chặn.
 *   - testPhones : danh sách SĐT được phép gửi khi testMode=true.
 *
 * Nguồn giá trị:
 *   1) File override config/test-mode.json (do UI ghi qua PUT /api/test-mode) — ưu tiên.
 *   2) Chưa có file -> lấy mặc định từ .env (TEST_MODE / TEST_PHONES).
 *
 * Đọc lại file mỗi lần get() nên chỉnh trên UI có hiệu lực NGAY cho lần gửi kế tiếp.
 */

// Chuẩn hoá danh sách SĐT: nhận mảng hoặc chuỗi (phân tách bằng phẩy/xuống dòng), bỏ trống + trùng.
function normPhones(input) {
  const arr = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\n,]/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = String(raw == null ? '' : raw).trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Mặc định từ .env (khi chưa có file override).
function envDefaults() {
  return { testMode: !!config.testMode, testPhones: normPhones(config.testPhones) };
}

function get() {
  try {
    if (fs.existsSync(config.testModeFile)) {
      const obj = JSON.parse(fs.readFileSync(config.testModeFile, 'utf8'));
      if (obj && typeof obj === 'object') {
        const def = envDefaults();
        return {
          testMode: obj.testMode === undefined ? def.testMode : !!obj.testMode,
          testPhones: obj.testPhones === undefined ? def.testPhones : normPhones(obj.testPhones),
        };
      }
    }
  } catch {
    /* file hỏng -> quay về mặc định .env, tránh crash */
  }
  return envDefaults();
}

/**
 * Cập nhật 1 phần (testMode và/hoặc testPhones) rồi ghi ra file. Trả về trạng thái sau cập nhật.
 * @param {{testMode?:boolean, testPhones?:(string|string[])}} patch
 */
function set(patch = {}) {
  const cur = get();
  const next = {
    testMode: patch.testMode === undefined ? cur.testMode : !!patch.testMode,
    testPhones: patch.testPhones === undefined ? cur.testPhones : normPhones(patch.testPhones),
  };
  const dir = path.dirname(config.testModeFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.testModeFile, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { get, set, normPhones };
