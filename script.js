function showTime() {
	document.getElementById('currentTime').innerHTML = new Date().toUTCString();
}
showTime();
setInterval(function () {
	showTime();
}, 1000);

/* ============================================================
   SMART ATTENDANCE SCANNER ENGINE V2
   QR/BARCODE -> ISN -> MASTER SISWA -> SUPABASE -> DASHBOARD
   ============================================================ */

window.smartAttendanceScanQueue = [];
window.smartAttendanceScanBusy = false;
window.smartAttendanceRecentCodes = new Map();

const SMART_SCAN_DUPLICATE_MS = 1500;


/**
 * Normalisasi kode QR / Barcode.
 * QR siswa diharapkan berisi ISN.
 */
function normalizeAttendanceScanCode(code) {
  return String(code || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}


/**
 * Mencegah kartu yang sama terbaca berkali-kali
 * ketika masih berada di depan kamera.
 */
function isDuplicateAttendanceScan(code) {
  const now = Date.now();
  const key = normalizeAttendanceScanCode(code);

  const last = window.smartAttendanceRecentCodes.get(key) || 0;

  if (now - last < SMART_SCAN_DUPLICATE_MS) {
    return true;
  }

  window.smartAttendanceRecentCodes.set(key, now);

  // Bersihkan memory lama
  for (const [k, t] of window.smartAttendanceRecentCodes.entries()) {
    if (now - t > 10000) {
      window.smartAttendanceRecentCodes.delete(k);
    }
  }

  return false;
}


/**
 * Masukkan hasil scan ke queue.
 *
 * Scanner TIDAK menunggu Supabase.
 */
function enqueueAttendanceScan(code) {

  const normalized = normalizeAttendanceScanCode(code);

  if (!normalized) return;

  if (isDuplicateAttendanceScan(normalized)) {
    return;
  }

  window.smartAttendanceScanQueue.push({
    code: normalized,
    createdAt: Date.now()
  });

  updateSmartScannerQueueStatus();

  processAttendanceScanQueue();
}


/**
 * Worker queue.
 *
 * Scanner boleh membaca kartu berikutnya
 * meskipun data sebelumnya masih diproses.
 */
async function processAttendanceScanQueue() {

  if (window.smartAttendanceScanBusy) return;

  window.smartAttendanceScanBusy = true;

  try {

    while (window.smartAttendanceScanQueue.length > 0) {

      const item = window.smartAttendanceScanQueue.shift();

      if (!item) continue;

      try {

        await processOneAttendanceScan(item.code);

      } catch (err) {

        console.error(
          'Attendance scan processing error:',
          err
        );

      }

      updateSmartScannerQueueStatus();

      // Beri browser kesempatan melakukan frame kamera berikutnya
      await new Promise(resolve => setTimeout(resolve, 20));
    }

  } finally {

    window.smartAttendanceScanBusy = false;

    updateSmartScannerQueueStatus();
  }
}


/**
 * Proses SATU siswa.
 */
async function processOneAttendanceScan(code) {

  const scannedISN =
    normalizeStudentISN(code);

  if (!scannedISN) {

    showSmartAttendanceScanError(
      'QR / Barcode tidak berisi ISN siswa yang valid.'
    );

    return;
  }


  /* ==========================================================
     1. CARI SISWA BERDASARKAN ISN
     ========================================================== */

  let student =
    resolveAttendanceStudent('', scannedISN);


  /*
   * Jika master lokal belum menemukan,
   * coba langsung ke Supabase.
   */
  if (!student && cloudReady) {

    try {

      const cloud =
        await findStudentByISNServer(scannedISN);

      if (cloud?.id) {

        student = {
          id: cloud.id,
          name: cloud.name || '-',
          classGroup: cloud.class_group || '-',
          isn: scannedISN,
          studentIsn: scannedISN,
          nisn: scannedISN,
          student_isn: scannedISN,
          photo:
            cloud.photo_url ||
            cloud.photo ||
            defaultPhoto
        };
      }

    } catch (err) {

      console.warn(
        'Server ISN lookup failed:',
        err
      );
    }
  }


  /* ==========================================================
     2. SISWA TIDAK DITEMUKAN
     ========================================================== */

  if (!student) {

    showSmartAttendanceScanError(
      `ISN ${scannedISN} tidak ditemukan pada Master Siswa.`
    );

    return;
  }


  /* ==========================================================
     3. PASTIKAN IDENTITAS SUPABASE
     ========================================================== */

  student =
    await ensureAttendanceStudentId(student);


  if (!student?.id) {

    showSmartAttendanceScanError(
      `Data ${student.name} ditemukan, tetapi Student ID Supabase belum tersedia.`
    );

    return;
  }


  /* ==========================================================
     4. TAMPILKAN IDENTITAS SEBELUM/SAMBIL SAVE
     ========================================================== */

  renderLiveScanStudentResult(
    student,
    {
      type: 'PROCESSING',
      message: 'Menyimpan attendance ke server...'
    },
    selectedAttendanceMode
  );


  /* ==========================================================
     5. SIMPAN ATTENDANCE
     ========================================================== */

  const result =
    await recordAttendanceByResolvedStudent(
      student
    );


  /* ==========================================================
     6. TAMPILKAN HASIL
     ========================================================== */

  renderLiveScanStudentResult(
    student,
    result,
    result?.type === 'OUT'
      ? 'OUT'
      : 'IN'
  );


  /* ==========================================================
     7. AUDIO
     ========================================================== */

  if (
    result?.type === 'IN' ||
    result?.type === 'OUT'
  ) {

    try {
      playBeepSound();
    } catch (_) {}

    try {
      speakAttendanceThankYou(
        student.name,
        result.type === 'OUT'
          ? 'OUT'
          : 'IN'
      );
    } catch (_) {}
  }


  /* ==========================================================
     8. UPDATE SEMUA VIEW
     ========================================================== */

  if (
    result?.type === 'IN' ||
    result?.type === 'OUT'
  ) {

    await syncSavedAttendanceToAllViews(
      student,
      result,
      result.type
    );
  }
}


/**
 * Versi recordAttendance yang menerima object siswa.
 *
 * Ini menghindari pencarian ulang berdasarkan nama.
 */
async function recordAttendanceByResolvedStudent(student) {

  if (!student) {

    return {
      type: 'ERROR',
      message: 'Data siswa tidak ditemukan.'
    };
  }


  const isn =
    normalizeStudentISN(
      stableStudentISN(student)
    );


  if (!isn) {

    return {
      type: 'ERROR',
      message: 'ISN siswa tidak tersedia.'
    };
  }


  if (!student.id && cloudReady) {

    student =
      await ensureAttendanceStudentId(student);
  }


  if (!student.id) {

    return {
      type: 'ERROR',
      message:
        `${student.name} belum memiliki Student ID Supabase.`
    };
  }


  const mode =
    selectedAttendanceMode === 'OUT'
      ? 'OUT'
      : 'IN';


  const dateStr =
    todayISO();


  const timeStr =
    getJakartaTimeParts();


  /* ==========================================================
     CEK RECORD HARI INI
     ========================================================== */

  let existing = null;


  if (cloudReady) {

    const q =
      await supabaseClient
        .from('attendance_records')
        .select(
          'id,student_id,student_isn,time_in,time_out,status'
        )
        .eq(
          'student_id',
          student.id
        )
        .eq(
          'attendance_date',
          dateStr
        )
        .maybeSingle();


    if (q.error) {

      console.error(
        'Attendance lookup:',
        q.error
      );

    } else {

      existing = q.data || null;
    }
  }


  /* ==========================================================
     DUPLICATE PROTECTION
     ========================================================== */

  if (
    mode === 'IN' &&
    existing?.time_in
  ) {

    return {
      type: 'DUPLICATE',
      message:
        `Siswa ${student.name} sudah melakukan TIME IN.`,
      time: existing.time_in,
      classGroup: student.classGroup
    };
  }


  if (
    mode === 'OUT' &&
    existing?.time_out
  ) {

    return {
      type: 'DUPLICATE',
      message:
        `Siswa ${student.name} sudah melakukan TIME OUT.`,
      time: existing.time_out,
      classGroup: student.classGroup
    };
  }


  /* ==========================================================
     PAYLOAD RESMI
     ========================================================== */

  const payload = {

    student_id:
      student.id,

    student_isn:
      isn,

    student_name:
      String(student.name || '').trim(),

    class_group:
      String(student.classGroup || '').trim(),

    attendance_date:
      dateStr,

    time_in:
      mode === 'IN'
        ? timeStr
        : (existing?.time_in || null),

    time_out:
      mode === 'OUT'
        ? timeStr
        : (existing?.time_out || null),

    status:
      mode === 'IN'
        ? 'Hadir (Di Sekolah)'
        : 'Sudah Pulang',

    updated_at:
      new Date().toISOString()
  };


  /* ==========================================================
     SUPABASE UPSERT
     ========================================================== */

  if (!cloudReady) {

    return {
      type:
        mode === 'IN'
          ? 'IN_QUEUED'
          : 'OUT_QUEUED',

      time: timeStr,

      classGroup:
        student.classGroup,

      message:
        'Attendance diamankan sementara dan akan disinkronkan ke server.'
    };
  }


  const upsert =
    await supabaseClient
      .from('attendance_records')
      .upsert(
        payload,
        {
          onConflict:
            'student_id,attendance_date'
        }
      )
      .select()
      .maybeSingle();


  if (upsert.error) {

    console.error(
      'Attendance Supabase error:',
      upsert.error
    );

    return {
      type: 'ERROR',
      message:
        `Gagal menyimpan attendance: ${upsert.error.message}`
    };
  }


  /* ==========================================================
     SERVER ACK
     ========================================================== */

  return {

    type:
      mode === 'IN'
        ? 'IN'
        : 'OUT',

    time:
      timeStr,

    classGroup:
      student.classGroup,

    saved:
      true,

    studentId:
      student.id,

    studentIsn:
      isn,

    studentName:
      student.name
  };
}


/**
 * Status queue scanner.
 */
function updateSmartScannerQueueStatus() {

  const el =
    document.getElementById(
      'mobileScannerStatus'
    );

  if (!el) return;

  const count =
    window.smartAttendanceScanQueue.length;


  if (count > 0) {

    el.textContent =
      `⚡ ${count} scan menunggu sinkronisasi server...`;

    return;
  }


  if (window.smartAttendanceScanBusy) {

    el.textContent =
      '🔄 Attendance sedang disinkronkan...';

    return;
  }
}


/**
 * Error scanner.
 */
function showSmartAttendanceScanError(message) {

  console.warn(
    'SMART ATTENDANCE:',
    message
  );

  const result =
    document.getElementById(
      'unifiedCameraResult'
    );

  if (result) {

    result.textContent =
      `❌ ${message}`;
  }


  const box =
    document.getElementById(
      'scan-result'
    );

  if (box) {

    box.className =
      'result-box warning';

    box.textContent =
      `❌ ${message}`;
  }
}

const onScan = (decodedText) => {

  const code =
    String(decodedText || '').trim();

  if (!code) return;

  /*
   * Jangan menunggu Supabase.
   * Jangan menggunakan global processing lock.
   */
  enqueueAttendanceScan(code);
};

async function syncAttendanceAfterServerAck(student, result) {

  try {

    renderLiveScanStudentResult(
      student,
      result,
      result.type === 'OUT'
        ? 'OUT'
        : 'IN'
    );

  } catch (_) {}


  /*
   * Refresh seluruh komponen Dashboard.
   */
  await Promise.allSettled([

    updateDashboardStats(),

    renderTodayStudentRoster(),

    renderAttendanceTable(),

    renderAttendanceHistory()

  ]);


  /*
   * Ping antar-tab.
   */
  try {

    localStorage.setItem(
      'smartAttendanceDashboardPing',

      JSON.stringify({

        t: Date.now(),

        source:
          'QR_SCAN_SERVER_ACK',

        studentId:
          student.id,

        studentIsn:
          stableStudentISN(student),

        studentName:
          student.name,

        classGroup:
          student.classGroup,

        mode:
          result.type,

        date:
          todayISO(),

        time:
          result.time
      })
    );

  } catch (_) {}
}

async function syncAttendanceAfterServerAck(student, result) {

  try {

    renderLiveScanStudentResult(
      student,
      result,
      result.type === 'OUT'
        ? 'OUT'
        : 'IN'
    );

  } catch (_) {}


  /*
   * Refresh seluruh komponen Dashboard.
   */
  await Promise.allSettled([

    updateDashboardStats(),

    renderTodayStudentRoster(),

    renderAttendanceTable(),

    renderAttendanceHistory()

  ]);


  /*
   * Ping antar-tab.
   */
  try {

    localStorage.setItem(
      'smartAttendanceDashboardPing',

      JSON.stringify({

        t: Date.now(),

        source:
          'QR_SCAN_SERVER_ACK',

        studentId:
          student.id,

        studentIsn:
          stableStudentISN(student),

        studentName:
          student.name,

        classGroup:
          student.classGroup,

        mode:
          result.type,

        date:
          todayISO(),

        time:
          result.time
      })
    );

  } catch (_) {}
}

supabaseClient
  .channel('smart-attendance-realtime-v4')
  .on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'attendance_records'
    },
    payload => {

      refreshAllAttendanceRealtime(
        `attendance_records:${payload.eventType}`
      );

    }
  );