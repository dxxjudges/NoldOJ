    document.getElementById('nav').innerHTML = renderNav('admin');
    let currentProblemId = null;
    let currentGroups = [];
    let currentTestCases = [];
    let editingTcId = null;
    let adminProblemsCache = [];
    let adminContestsCache = [];

    function showTab(tab) {
      ['problems','users','groups','articles','files','contests','categories','tags','announcements'].forEach(t => {
        document.getElementById(`panel-${t}`).classList.toggle('hidden', t !== tab);
        const btn = document.getElementById(`tab-${t}`);
        btn.className = t === tab ? 'px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white' : 'px-4 py-2 rounded-xl text-sm font-medium bg-white border border-gray-300 text-gray-600 hover:bg-gray-50';
        // 仅同步 aria-selected（不影响渲染/行为）：让读屏软件播报当前所在的管理面板
        btn.setAttribute('aria-selected', String(t === tab));
      });
      if (tab === 'users') { loadUsers(); initUserAdminTools(); }
      if (tab === 'groups') { loadUserGroups(); initUserGroupImportTools(); }
      if (tab === 'articles') loadAdminArticles();
      if (tab === 'files') loadAdminFiles();
      if (tab === 'contests') loadContests();
      if (tab === 'problems') loadAdminProblems();
      if (tab === 'categories') loadAdminCategories();
      if (tab === 'tags') loadAdminTags();
      if (tab === 'announcements') loadAdminAnnouncements();
    }
    function showCreateContest() {
      // 可见性控件仅 admin/su 可见；新建默认公开
      initVisibilityControl('cVisibilityBox', 'cVisibility', 'cVisibilityGroups');
      document.getElementById('createContestForm').classList.remove('hidden');
    }
    function hideCreateContest() { document.getElementById('createContestForm').classList.add('hidden'); }

    let editingAnnouncementId = null;
    async function loadAdminAnnouncements() {
      try {
        const data = await apiCall('GET', '/announcements?type=global&page=1&size=50');
        const el = document.getElementById('adminAnnouncements');
        if (!data.announcements || data.announcements.length === 0) {
          el.innerHTML = '<p class="text-gray-400 text-center py-8">暂无公告</p>';
          return;
        }
        el.innerHTML = data.announcements.map(a => `
          <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-4 flex items-center justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                ${a.pinned ? '<span class="px-1.5 py-0.5 text-xs rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">置顶</span>' : ''}
                <span class="font-medium text-gray-900 dark:text-white truncate">${escapeHtml(a.title)}</span>
              </div>
              <p class="text-xs text-gray-400 mt-1">${escapeHtml(a.nickname || a.username || '')} · ${new Date(a.created_at).toLocaleString()}</p>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button onclick="toggleAnnPinned(${a.id}, ${a.pinned ? 0 : 1})" class="text-xs px-2 py-1 rounded ${a.pinned?'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300':'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300'} hover:opacity-80">${a.pinned?'取消置顶':'置顶'}</button>
              <button onclick="editAnnouncement(${a.id})" class="text-blue-600 dark:text-blue-400 text-sm hover:underline">编辑</button>
              <button onclick="deleteAnnouncement(${a.id})" class="text-red-600 dark:text-red-400 text-sm hover:underline">删除</button>
            </div>
          </div>
        `).join('');
      } catch (err) {
        document.getElementById('adminAnnouncements').innerHTML = `<p class="text-red-500 text-center py-8">${escapeHtml(err.message) || '加载失败'}</p>`;
      }
    }
    function showCreateAnnouncement() {
      editingAnnouncementId = null;
      document.getElementById('announcementFormTitle').textContent = '发布公告';
      document.getElementById('announcementSaveBtn').textContent = '创建';
      document.getElementById('annTitle').value = '';
      document.getElementById('annType').value = 'global';
      document.getElementById('annPinned').checked = false;
      document.getElementById('annContent').value = '';
      document.getElementById('annPreview').innerHTML = '<p class="text-gray-400">预览区...</p>';
      toggleAnnContest();
      document.getElementById('createAnnouncementForm').classList.remove('hidden');
    }
    function hideCreateAnnouncement() { document.getElementById('createAnnouncementForm').classList.add('hidden'); }
    async function toggleAnnContest() {
      const type = document.getElementById('annType').value;
      const sel = document.getElementById('annContestId');
      if (type === 'contest') {
        sel.classList.remove('hidden');
        try {
          const data = await apiCall('GET', '/contests?page=1&limit=100');
          const contests = data.contests || data.data || [];
          sel.innerHTML = contests.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('') || '<option value="">无可用比赛</option>';
        } catch { sel.innerHTML = '<option value="">加载比赛失败</option>'; }
      } else {
        sel.classList.add('hidden');
      }
    }
    function previewAnnouncement() {
      const content = document.getElementById('annContent').value;
      const el = document.getElementById('annPreview');
      el.innerHTML = renderMarkdown(content);
      if (typeof renderMathDefaults === 'function') renderMathDefaults(el);
    }
    async function saveAnnouncement() {
      const title = document.getElementById('annTitle').value.trim();
      const content = document.getElementById('annContent').value.trim();
      const type = document.getElementById('annType').value;
      const contest_id = document.getElementById('annContestId').value;
      const pinned = document.getElementById('annPinned').checked ? 1 : 0;
      if (!title) { showToast('请输入标题', 'info'); return; }
      if (!content) { showToast('请输入内容', 'info'); return; }
      const btn = document.getElementById('announcementSaveBtn');
      btn.disabled = true; btn.textContent = '保存中...';
      try {
        if (editingAnnouncementId) {
          await apiCall('PUT', `/announcements/${editingAnnouncementId}`, { title, content, type, contest_id, pinned });
        } else {
          await apiCall('POST', '/announcements', { title, content, type, contest_id, pinned });
        }
        hideCreateAnnouncement();
        loadAdminAnnouncements();
      } catch (err) {
        showToast(err.message || '保存失败', 'error');
      } finally {
        btn.disabled = false; btn.textContent = editingAnnouncementId ? '保存' : '创建';
      }
    }
    async function editAnnouncement(id) {
      try {
        const a = await apiCall('GET', `/announcements/${id}`);
        editingAnnouncementId = id;
        document.getElementById('announcementFormTitle').textContent = '编辑公告';
        document.getElementById('announcementSaveBtn').textContent = '保存';
        document.getElementById('annTitle').value = a.title;
        document.getElementById('annType').value = a.type;
        document.getElementById('annPinned').checked = !!a.pinned;
        document.getElementById('annContent').value = a.content;
        previewAnnouncement();
        await toggleAnnContest();
        if (a.type === 'contest' && a.contest_id) document.getElementById('annContestId').value = a.contest_id;
        document.getElementById('createAnnouncementForm').classList.remove('hidden');
      } catch (err) { showToast(err.message || '加载失败', 'error'); }
    }
    async function toggleAnnPinned(id, pinned) {
      try {
        await apiCall('PUT', `/announcements/${id}`, { pinned });
        loadAdminAnnouncements();
      } catch (err) { showToast(err.message || '操作失败', 'error'); }
    }
    async function deleteAnnouncement(id) {
      if (!confirm('确定删除该公告？此操作不可撤销。')) return;
      try {
        await apiCall('DELETE', `/announcements/${id}`);
        loadAdminAnnouncements();
      } catch (err) { showToast(err.message || '删除失败', 'error'); }
    }

    async function loadAdminProblems() {
      try {
        const data = await apiCall('GET', '/problems?limit=100');
        adminProblemsCache = data.problems;
        const curUser = getUser();
        const canReindex = curUser && ['admin', 'su'].includes(curUser.role);
        document.getElementById('adminProblems').innerHTML = data.problems.map(p => `
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700 dark:bg-gray-700">
            <td class="px-4 py-3 text-sm">${p.id}</td>
            <td class="px-4 py-3 text-sm font-medium">${escapeHtml(p.title)}</td>
            <td class="px-4 py-3 text-center text-sm">${(p.categories || []).map(c => `<span class="px-1.5 py-0.5 text-xs rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 mr-1">${escapeHtml(c.name)}</span>`).join('')}</td>
            <td class="px-4 py-3 text-center text-sm">${p.problem_type === 'traditional' ? '传统题' : p.problem_type}</td>
            <td class="px-4 py-3 text-center text-sm">${p.subtask_mode === 'advanced' ? '分组' : '简单'}</td>
            <td class="px-4 py-3 text-center text-sm" id="tc-count-${p.id}">-</td>
            <td class="px-4 py-3 text-center">${p.is_public ? '<span class="text-green-600 dark:text-green-400">是</span>' : '<span class="text-red-600 dark:text-red-400">否</span>'}</td>
            <td class="px-4 py-3 text-center">
              <a href="/pages/problem.html?id=${p.id}" class="text-indigo-600 dark:text-indigo-400 text-sm hover:underline mr-2">查看</a>
              <button onclick="editProblem(${p.id})" class="text-blue-600 dark:text-blue-400 text-sm hover:underline mr-2">编辑</button>
              <button onclick="openTestManager(${p.id})" class="text-green-600 dark:text-green-400 text-sm hover:underline mr-2">测试点</button>
              <button onclick="startPlagiarismCheck(${p.id})" class="text-purple-600 dark:text-purple-400 text-sm hover:underline mr-2" title="代码查重">查重</button>
              <button onclick="exportProblem(${p.id})" class="text-orange-600 dark:text-orange-400 text-sm hover:underline mr-2" title="导出为 ZIP">导出</button>
              ${canReindex ? `<button onclick="reindexProblem(${p.id})" class="text-cyan-600 dark:text-cyan-400 text-sm hover:underline mr-2" title="改编号到指定空位置">改号</button>` : ''}
              <button onclick="deleteProblem(${p.id})" class="text-red-600 dark:text-red-400 text-sm hover:underline">删除</button>
            </td>
          </tr>
        `).join('');
        for (const p of data.problems) {
          try {
            const tcs = await apiCall('GET', `/problems/${p.id}/testdata`);
            const el = document.getElementById(`tc-count-${p.id}`);
            if (el) el.textContent = tcs.length;
          } catch {}
        }
      } catch (err) { console.error(err); }
    }

    let editingProblemId = null;
  let allCategoriesCache = [];

    async function loadAllCategories() {
      try {
        allCategoriesCache = await apiCall('GET', '/categories');
        const sel = document.getElementById('pCategories');
        if (sel) {
          sel.innerHTML = allCategoriesCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        }
      } catch (err) { console.error(err); }
    }

    async function loadProblemCategories(problemId) {
      try {
        const data = await apiCall('GET', '/problems?limit=100');
        const problem = data.problems.find(p => p.id === problemId);
        if (problem && problem.categories) {
          const sel = document.getElementById('pCategories');
          const selectedIds = problem.categories.map(c => c.id);
          Array.from(sel.options).forEach(opt => {
            opt.selected = selectedIds.includes(parseInt(opt.value));
          });
        }
      } catch (err) { console.error(err); }
    }

    async function saveProblemCategories(problemId) {
      const sel = document.getElementById('pCategories');
      const selectedIds = Array.from(sel.selectedOptions).map(o => parseInt(o.value));
      try {
        const currentCats = await apiCall('GET', '/problems?limit=100');
        const problem = currentCats.problems.find(p => p.id === problemId);
        if (problem && problem.categories) {
          for (const cat of problem.categories) {
            if (!selectedIds.includes(cat.id)) {
              await apiCall('DELETE', `/categories/${cat.id}/problems/${problemId}`);
            }
          }
        }
        for (const catId of selectedIds) {
          await apiCall('POST', `/categories/${catId}/problems/${problemId}`);
        }
      } catch (err) { console.error(err); }
    }

    let allTagsCache = [];

    async function loadAllTags() {
      try {
        allTagsCache = await apiCall('GET', '/tags');
        const sel = document.getElementById('pTags');
        if (sel) {
          sel.innerHTML = allTagsCache.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
        }
      } catch (err) { console.error(err); }
    }

    async function loadProblemTags(problemId) {
      try {
        const tags = await apiCall('GET', `/tags/problem/${problemId}`);
        const sel = document.getElementById('pTags');
        if (sel) {
          const selectedIds = tags.map(t => t.id);
          Array.from(sel.options).forEach(opt => {
            opt.selected = selectedIds.includes(parseInt(opt.value));
          });
        }
      } catch (err) { console.error(err); }
    }

    async function saveProblemTags(problemId) {
      const sel = document.getElementById('pTags');
      if (!sel) return;
      const tagIds = Array.from(sel.selectedOptions).map(o => parseInt(o.value));
      try {
        await apiCall('POST', `/tags/problem/${problemId}`, { tag_ids: tagIds });
      } catch (err) { console.error(err); }
    }

    async function loadAdminCategories() {
      try {
        const cats = await apiCall('GET', '/categories');
        const tbody = document.getElementById('categoryList');
        tbody.innerHTML = cats.map(c => `
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700">
            <td class="px-4 py-3 text-sm">${c.id}</td>
            <td class="px-4 py-3 text-sm font-medium">${escapeHtml(c.name)}</td>
            <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">${escapeHtml(c.description || '-')}</td>
            <td class="px-4 py-3 text-center text-sm">${c.problem_count || 0}</td>
            <td class="px-4 py-3 text-center text-sm">${c.sort_order || 0}</td>
            <td class="px-4 py-3 text-center">
              <button onclick="editCategory(${c.id})" class="text-blue-600 dark:text-blue-400 text-sm hover:underline mr-2">编辑</button>
              <button onclick="deleteCategory(${c.id})" class="text-red-600 dark:text-red-400 text-sm hover:underline">删除</button>
            </td>
          </tr>
        `).join('');
      } catch (err) { console.error(err); }
    }

    let editingCategoryId = null;

    function showCreateCategory() {
      editingCategoryId = null;
      document.getElementById('categoryFormTitle').textContent = '新建分类';
      document.getElementById('categorySaveBtn').textContent = '创建';
      document.getElementById('catName').value = '';
      document.getElementById('catDesc').value = '';
      document.getElementById('catOrder').value = '0';
      document.getElementById('createCategoryForm').classList.remove('hidden');
    }
    function hideCreateCategory() { document.getElementById('createCategoryForm').classList.add('hidden'); editingCategoryId = null; }

    async function editCategory(id) {
      try {
        const c = await apiCall('GET', `/categories/${id}`);
        editingCategoryId = id;
        document.getElementById('categoryFormTitle').textContent = `编辑分类 #${id}`;
        document.getElementById('categorySaveBtn').textContent = '保存';
        document.getElementById('catName').value = c.name || '';
        document.getElementById('catDesc').value = c.description || '';
        document.getElementById('catOrder').value = c.sort_order || 0;
        document.getElementById('createCategoryForm').classList.remove('hidden');
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function saveCategory() {
      const data = {
        name: document.getElementById('catName').value,
        description: document.getElementById('catDesc').value,
        sort_order: parseInt(document.getElementById('catOrder').value) || 0
      };
      try {
        if (editingCategoryId) {
          await apiCall('PUT', `/categories/${editingCategoryId}`, data);
        } else {
          await apiCall('POST', '/categories', data);
        }
        hideCreateCategory();
        loadAdminCategories();
        loadAllCategories();
      } catch (err) { showToast(err.message || '操作失败', 'error'); }
    }

    async function deleteCategory(id) {
      if (!confirm('确定删除此分类？分类下的题目不会被删除，但关联关系将被移除。')) return;
      try {
        await apiCall('DELETE', `/categories/${id}`);
        loadAdminCategories();
        loadAllCategories();
      } catch (err) { showToast(err.message, 'error'); }
    }

    // ── 标签管理 ─────────────────────────────
    let editingTagId = null;

    async function loadAdminTags() {
      try {
        const tags = await apiCall('GET', '/tags');
        const tbody = document.getElementById('tagList');
        tbody.innerHTML = tags.map(t => `
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700">
            <td class="px-4 py-3 text-sm">${t.id}</td>
            <td class="px-4 py-3 text-sm"><span class="px-2 py-0.5 text-xs rounded-full" style="background-color: ${escapeHtml(t.color)}20; color: ${escapeHtml(t.color)}">${escapeHtml(t.name)}</span></td>
            <td class="px-4 py-3 text-center text-sm">${t.problem_count || 0}</td>
            <td class="px-4 py-3 text-center">
              <button onclick="editTag(${t.id})" class="text-blue-600 dark:text-blue-400 text-sm hover:underline mr-2">编辑</button>
              <button onclick="deleteTag(${t.id})" class="text-red-600 dark:text-red-400 text-sm hover:underline">删除</button>
            </td>
          </tr>
        `).join('');
      } catch (err) { console.error(err); }
    }

    function updateTagPreview() {
      const c = document.getElementById('tagColor').value;
      const p = document.getElementById('tagColorPreview');
      if (p) { p.style.backgroundColor = c + '20'; p.style.color = c; }
    }

    function showCreateTag() {
      editingTagId = null;
      document.getElementById('tagFormTitle').textContent = '新建标签';
      document.getElementById('tagSaveBtn').textContent = '创建';
      document.getElementById('tagName').value = '';
      document.getElementById('tagColor').value = '#6366f1';
      updateTagPreview();
      document.getElementById('createTagForm').classList.remove('hidden');
    }
    function hideCreateTag() { document.getElementById('createTagForm').classList.add('hidden'); editingTagId = null; }

    async function editTag(id) {
      try {
        const t = allTagsCache.find(x => x.id === id) || await apiCall('GET', `/tags/${id}`);
        editingTagId = id;
        document.getElementById('tagFormTitle').textContent = `编辑标签 #${id}`;
        document.getElementById('tagSaveBtn').textContent = '保存';
        document.getElementById('tagName').value = t.name || '';
        document.getElementById('tagColor').value = /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : '#6366f1';
        updateTagPreview();
        document.getElementById('createTagForm').classList.remove('hidden');
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function saveTag() {
      const name = document.getElementById('tagName').value.trim();
      if (!name) { showToast('请输入标签名称', 'info'); return; }
      const color = document.getElementById('tagColor').value;
      const data = { name, color };
      try {
        if (editingTagId) {
          await apiCall('PUT', `/tags/${editingTagId}`, data);
        } else {
          await apiCall('POST', '/tags', data);
        }
        hideCreateTag();
        loadAdminTags();
        loadAllTags();
      } catch (err) { showToast(err.message || '操作失败', 'error'); }
    }

    async function deleteTag(id) {
      if (!confirm('确定删除此标签？该标签将从所有题目上移除，不影响题目本身。')) return;
      try {
        await apiCall('DELETE', `/tags/${id}`);
        loadAdminTags();
        loadAllTags();
      } catch (err) { showToast(err.message, 'error'); }
    }

    function showCreateProblem() {
      editingProblemId = null;
      document.getElementById('problemFormTitle').textContent = '新建题目';
      document.getElementById('problemSaveBtn').textContent = '创建';
      document.getElementById('pTitle').value = '';
      document.getElementById('pType').value = 'traditional';
      document.getElementById('pTimeLimit').value = '1000';
      document.getElementById('pMemLimit').value = '256';
      document.getElementById('pCompare').value = 'text_strict';
      document.getElementById('pSubtask').value = 'simple';
      document.getElementById('pDesc').value = '';
      document.getElementById('pInput').value = '';
      document.getElementById('pOutput').value = '';
      document.getElementById('pHint').value = '';
      document.getElementById('pProvider').value = '';
      renderSampleRows([]);
      document.getElementById('pDifficulty').value = '0';
      const catSel = document.getElementById('pCategories');
      if (catSel) Array.from(catSel.options).forEach(opt => opt.selected = false);
      const tagSel = document.getElementById('pTags');
      if (tagSel) Array.from(tagSel.options).forEach(opt => opt.selected = false);
      // 可见性：新建默认公开；控件仅 admin/su 可见（HTML 里默认 hidden）
      initVisibilityControl('pVisibilityBox', 'pVisibility', 'pVisibilityGroups');
      document.getElementById('createProblemForm').classList.remove('hidden');
    }
    function hideCreateProblem() { document.getElementById('createProblemForm').classList.add('hidden'); editingProblemId = null; }

    async function editProblem(id) {
      try {
        const p = await apiCall('GET', `/problems/${id}`);
        editingProblemId = id;
        document.getElementById('problemFormTitle').textContent = `编辑题目 #${id}`;
        document.getElementById('problemSaveBtn').textContent = '保存';
        document.getElementById('pTitle').value = p.title || '';
        document.getElementById('pType').value = p.problem_type || 'traditional';
        document.getElementById('pTimeLimit').value = p.time_limit || 1000;
        document.getElementById('pMemLimit').value = p.memory_limit || 256;
        document.getElementById('pCompare').value = p.compare_mode || 'text_strict';
        document.getElementById('pSubtask').value = p.subtask_mode || 'simple';
        document.getElementById('pDesc').value = p.description || '';
        document.getElementById('pBg').value = p.background || '';
        document.getElementById('pInput').value = p.input_desc || '';
        document.getElementById('pOutput').value = p.output_desc || '';
        document.getElementById('pHint').value = p.hint || '';
        document.getElementById('pProvider').value = p.provider || '';
        {
          const samples = Array.isArray(p.samples) && p.samples.length > 0
            ? p.samples
            : ((p.sample_input || p.sample_output) ? [{ input: p.sample_input || '', output: p.sample_output || '', note: '' }] : []);
          renderSampleRows(samples);
        }
        document.getElementById('pDifficulty').value = String(p.difficulty || 0);
        document.getElementById('createProblemForm').classList.remove('hidden');
        await loadAllCategories();
        await loadProblemCategories(id);
        await loadAllTags();
        await loadProblemTags(id);
        // 可见性回填：GET /problems/:id/visibility（仅 admin/su）
        if (canManageVisibility()) {
          showVisibilityControl('pVisibilityBox', 'pVisibilityGroups');
          await loadEntityVisibility('problems', id, 'pVisibility', 'pVisibilityGroups');
        }
      } catch (err) { showToast(err.message, 'error'); }
    }

    // R12-1: 多样例编辑器 ─────────────────────────────
    function collectSamples() {
      return Array.from(document.querySelectorAll('#sampleRows .sample-row')).map(row => ({
        input: row.querySelector('.sample-in').value,
        output: row.querySelector('.sample-out').value,
        note: row.querySelector('.sample-note').value
      })).filter(s => s.input !== '' || s.output !== '' || s.note !== '');
    }
    function renderSampleRows(samples) {
      const box = document.getElementById('sampleRows');
      box.innerHTML = '';
      if (!samples || samples.length === 0) { addSampleRow(); return; }
      samples.forEach(s => addSampleRow(s));
    }
    function addSampleRow(sample) {
      const s = sample || { input: '', output: '', note: '' };
      const box = document.getElementById('sampleRows');
      const idx = box.children.length + 1;
      const div = document.createElement('div');
      div.className = 'sample-row border border-gray-200 dark:border-gray-700 rounded-xl p-3';
      div.innerHTML = `
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-semibold text-gray-600 dark:text-gray-300">样例 #<span class="sample-idx">${idx}</span></span>
          <div class="flex items-center space-x-2">
            <button type="button" onclick="moveSampleRow(this, -1)" title="上移" aria-label="上移样例" class="text-xs px-1.5 py-0.5 text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400">↑</button>
            <button type="button" onclick="moveSampleRow(this, 1)" title="下移" aria-label="下移样例" class="text-xs px-1.5 py-0.5 text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400">↓</button>
            <button type="button" onclick="this.closest('.sample-row').remove(); renumberSampleRows()" aria-label="删除该样例" class="text-xs px-2 py-0.5 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded">删除</button>
          </div>
        </div>
        <input class="sample-note w-full mb-2 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-800 dark:text-white" aria-label="样例说明" placeholder="样例说明 (可选, 如: 最小数据)" value="${(s.note || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <textarea class="sample-in w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-xl font-mono text-sm text-left focus:ring-2 focus:ring-indigo-500 outline-none resize-none dark:bg-gray-800 dark:text-white" rows="3" aria-label="样例输入" placeholder="输入"></textarea>
          <textarea class="sample-out w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-xl font-mono text-sm text-left focus:ring-2 focus:ring-indigo-500 outline-none resize-none dark:bg-gray-800 dark:text-white" rows="3" aria-label="样例输出" placeholder="输出"></textarea>
        </div>`;
      div.querySelector('.sample-in').value = s.input || '';
      div.querySelector('.sample-out').value = s.output || '';
      box.appendChild(div);
      renumberSampleRows();
    }
    function moveSampleRow(btn, dir) {
      const row = btn.closest('.sample-row');
      const box = document.getElementById('sampleRows');
      const kids = Array.from(box.children);
      const i = kids.indexOf(row);
      const j = i + dir;
      if (j < 0 || j >= kids.length) return;
      if (dir === -1) box.insertBefore(row, kids[j]);
      else box.insertBefore(kids[j], row);
      renumberSampleRows();
    }
    function renumberSampleRows() {
      document.querySelectorAll('#sampleRows .sample-row').forEach((row, i) => {
        const el = row.querySelector('.sample-idx');
        if (el) el.textContent = String(i + 1);
      });
    }

    async function saveProblem() {
      const data = {
        title: document.getElementById('pTitle').value,
        description: document.getElementById('pDesc').value,
        background: document.getElementById('pBg').value,
        input_desc: document.getElementById('pInput').value,
        output_desc: document.getElementById('pOutput').value,
        hint: document.getElementById('pHint').value,
        problem_type: document.getElementById('pType').value,
        time_limit: parseInt(document.getElementById('pTimeLimit').value),
        memory_limit: parseInt(document.getElementById('pMemLimit').value),
        compare_mode: document.getElementById('pCompare').value,
        subtask_mode: document.getElementById('pSubtask').value,
        provider: document.getElementById('pProvider').value,
        samples: collectSamples(),
        difficulty: parseInt(document.getElementById('pDifficulty').value) || 0,
      };
      try {
        let newId = editingProblemId;
        if (editingProblemId) {
          await apiCall('PUT', `/problems/${editingProblemId}`, data);
        } else {
          const res = await apiCall('POST', '/problems', data);
          newId = res.id;
        }
        if (newId) {
          await saveProblemCategories(newId);
          await saveProblemTags(newId);
        }
        hideCreateProblem();
        loadAdminProblems();
        // 题目主数据已保存，再补可见性（失败仅 toast 提示「主数据已保存，可见性设置失败」，不回滚）
        if (newId) await saveEntityVisibility('problems', newId, 'pVisibility', 'pVisibilityGroups');
      } catch (err) { showToast(err.message || '操作失败', 'error'); }
    }

    async function deleteProblem(id) {
      if (!confirm('确定删除此题目？')) return;
      try { await apiCall('DELETE', `/problems/${id}`); loadAdminProblems(); } catch (err) { showToast(err.message, 'error'); }
    }

    async function reindexProblem(id) {
      const input = prompt(`将题目 #${id} 重编号为（必须是未被占用的正整数）：`);
      if (input === null) return;
      const newId = input.trim();
      if (!/^\d+$/.test(newId) || parseInt(newId, 10) < 1) { showToast('请输入有效的正整数编号', 'info'); return; }
      if (parseInt(newId, 10) === id) { showToast('目标编号与当前编号相同', 'info'); return; }
      if (!confirm(`确定将题目 #${id} 重编号为 #${newId}？\n将同步更新所有提交、测试点、收藏、讨论等关联数据，且不可撤销。`)) return;
      try {
        const res = await apiCall('PUT', `/problems/${id}/reindex`, { new_id: parseInt(newId, 10) });
        showToast(`重编号成功：#${res.old_id} → #${res.id}`, 'success');
        loadAdminProblems();
      } catch (err) { showToast(err.message || '重编号失败', 'error'); }
    }

    async function deleteUser(uid) {
      const currentUser = getUser();
      const msg = uid === currentUser?.id ? '确定删除自己的账户？删除后将立即退出登录！' : '确定删除此用户？';
      if (!confirm(msg)) return;
      try {
        const res = await apiCall('DELETE', `/users/${uid}`);
        if (res.self) {
          clearToken();
          window.location.href = '/pages/index.html';
          return;
        }
        loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function sudoLogin(uid, username) {
      if (!confirm(`免密登录到用户 ${username}？`)) return;
      try {
        const res = await apiCall('POST', `/users/sudo-login`, { user_id: uid });
        setToken(res.access_token);
        setUser(res.user);
        window.location.href = '/pages/index.html';
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function openTestManager(pid) {
      currentProblemId = pid;
      document.getElementById('testManager').classList.remove('hidden');
      const cached = (adminProblemsCache.find(x => x.id === pid) || { title: '' }).title;
      document.getElementById('testManagerTitle').textContent = `测试点管理 - #${pid} ${cached}`;
      await loadGroups();
      await loadTestCases();
    }

    function hideTestManager() {
      document.getElementById('testManager').classList.add('hidden');
      currentProblemId = null;
    }

    async function loadGroups() {
      try {
        currentGroups = await apiCall('GET', `/problems/${currentProblemId}/groups`);
      } catch { currentGroups = []; }
      renderGroups();
    }

    function renderGroups() {
      const el = document.getElementById('groupsList');
      if (currentGroups.length === 0) {
        el.innerHTML = '<div class="text-sm text-gray-400 dark:text-gray-500 dark:text-gray-400 py-2">无分组（简单模式）</div>';
        return;
      }
      el.innerHTML = currentGroups.map(g => `
        <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-xl">
          <div class="flex items-center space-x-3">
            <span class="text-sm font-mono text-indigo-600 dark:text-indigo-400">#${g.id}</span>
            <span class="text-sm font-medium">${escapeHtml(g.subtask_id)}</span>
            <span class="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">满分: ${g.score}</span>
            <span class="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">聚合: ${g.aggregator}</span>
            ${g.dependency.length > 0 ? `<span class="text-xs text-orange-600 dark:text-orange-400">依赖: [${g.dependency.join(', ')}]</span>` : ''}
            ${g.scoring_script ? '<span class="text-xs text-green-600 dark:text-green-400">有计分脚本</span>' : ''}
          </div>
          <div class="flex space-x-2">
            <button onclick="showGroupEditor(${g.id})" class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">编辑</button>
            <button onclick="deleteGroup(${g.id})" class="text-xs text-red-600 dark:text-red-400 hover:underline">删除</button>
          </div>
        </div>
      `).join('');
    }

    let editingGroupId = null;

    function showGroupEditor(gid) {
      editingGroupId = gid || null;
      const el = document.getElementById('groupEditor');
      el.classList.remove('hidden');
      if (gid) {
        const g = currentGroups.find(x => x.id === gid);
        if (!g) return;
        document.getElementById('groupEditorTitle').textContent = `编辑分组 #${gid}`;
        document.getElementById('gSubtaskId').value = g.subtask_id;
        document.getElementById('gScore').value = g.score;
        document.getElementById('gAggregator').value = g.aggregator;
        document.getElementById('gDependency').value = g.dependency.join(', ');
        document.getElementById('gScript').value = g.scoring_script || '';
      } else {
        document.getElementById('groupEditorTitle').textContent = '添加分组';
        document.getElementById('gSubtaskId').value = '';
        document.getElementById('gScore').value = '0';
        document.getElementById('gAggregator').value = 'sum';
        document.getElementById('gDependency').value = '';
        document.getElementById('gScript').value = '';
      }
    }

    function hideGroupEditor() {
      document.getElementById('groupEditor').classList.add('hidden');
      editingGroupId = null;
    }

    async function saveGroup() {
      const subtask_id = document.getElementById('gSubtaskId').value.trim();
      if (!subtask_id) { showToast('请输入 Subtask ID', 'info'); return; }
      const score = parseFloat(document.getElementById('gScore').value) || 0;
      const aggregator = document.getElementById('gAggregator').value;
      const depStr = document.getElementById('gDependency').value.trim();
      const dependency = depStr ? depStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
      const scoring_script = document.getElementById('gScript').value;

      try {
        if (editingGroupId) {
          await apiCall('PUT', `/problems/${currentProblemId}/groups/${editingGroupId}`, {
            subtask_id, score, aggregator, dependency, scoring_script
          });
        } else {
          await apiCall('POST', `/problems/${currentProblemId}/groups`, {
            subtask_id, score, aggregator, dependency, scoring_script
          });
        }
        hideGroupEditor();
        await loadGroups();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function deleteGroup(gid) {
      if (!confirm('确定删除此分组？')) return;
      try {
        await apiCall('DELETE', `/problems/${currentProblemId}/groups/${gid}`);
        await loadGroups();
        await loadTestCases();
      } catch (err) { showToast(err.message, 'error'); }
    }

    function toggleProblemScript() {
      const wrap = document.getElementById('problemScriptWrap');
      const btn = document.getElementById('probScriptBtn');
      wrap.classList.toggle('hidden');
      btn.textContent = wrap.classList.contains('hidden') ? '展开' : '收起';
    }

    async function saveProblemScript() {
      const script = document.getElementById('problemScript').value;
      try {
        await apiCall('PUT', `/problems/${currentProblemId}/scoring-script`, { scoring_script: script });
        showToast('计分脚本已保存', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function loadTestCases() {
      try {
        currentTestCases = await apiCall('GET', `/problems/${currentProblemId}/testdata`);
      } catch { currentTestCases = []; }
      renderTestCases();
    }

    function renderTestCases() {
      const el = document.getElementById('testCasesList');
      if (currentTestCases.length === 0) {
        el.innerHTML = '<div class="text-sm text-gray-400 dark:text-gray-500 dark:text-gray-400 py-2">暂无测试点</div>';
        return;
      }
      el.innerHTML = currentTestCases.map((tc) => {
        const group = currentGroups.find(g => g.id === tc.group_id);
        return `
          <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-xl">
            <div class="flex items-center space-x-3">
              <span class="text-sm font-mono text-gray-500 dark:text-gray-400 dark:text-gray-500">#${tc.id}</span>
              <span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">排序: ${tc.sort_order}</span>
              <span class="text-xs px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded">分数: ${tc.score}</span>
              <span class="text-xs px-2 py-0.5 ${tc.time_limit ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300' : 'bg-gray-100 dark:bg-gray-600 text-gray-400 dark:text-gray-500'} rounded">${tc.time_limit ? tc.time_limit + 'ms' : '默认时限'}</span>
              <span class="text-xs px-2 py-0.5 ${tc.memory_limit ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : 'bg-gray-100 dark:bg-gray-600 text-gray-400 dark:text-gray-500'} rounded">${tc.memory_limit ? tc.memory_limit + 'MB' : '默认内存'}</span>
              ${group ? `<span class="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">分组: ${group.subtask_id}</span>` : '<span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">无分组</span>'}
              <span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400 max-w-[200px] truncate">输入: ${escapeHtml(tc.input_data || tc.input_file || '(空)').slice(0, 30)}</span>
              <span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400 max-w-[200px] truncate">输出: ${escapeHtml(tc.output_data || tc.output_file || '(空)').slice(0, 30)}</span>
            </div>
            <div class="flex space-x-2">
              <button onclick="editTestCase(${tc.id})" class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">编辑</button>
              <button onclick="deleteSingleTC(${tc.id})" class="text-xs text-red-600 dark:text-red-400 hover:underline">删除</button>
            </div>
          </div>
        `;
      }).join('');
      updateGroupSelect();
    }

    function updateGroupSelect() {
      const sel = document.getElementById('tcGroup');
      sel.innerHTML = '<option value="">无分组</option>' +
        currentGroups.map(g => `<option value="${g.id}">${g.subtask_id} (#${g.id})</option>`).join('');
    }

    function addTestCase() {
      editingTcId = null;
      document.getElementById('tcEditorTitle').textContent = '添加测试点';
      document.getElementById('tcInput').value = '';
      document.getElementById('tcOutput').value = '';
      document.getElementById('tcScore').value = '0';
      document.getElementById('tcTimeLimit').value = '';
      document.getElementById('tcMemLimit').value = '';
      document.getElementById('tcGroup').value = '';
      document.getElementById('tcEditor').classList.remove('hidden');
      updateGroupSelect();
    }

    function editTestCase(tcid) {
      const tc = currentTestCases.find(x => x.id === tcid);
      if (!tc) return;
      editingTcId = tcid;
      document.getElementById('tcEditorTitle').textContent = `编辑测试点 #${tcid}`;
      document.getElementById('tcInput').value = tc.input_data || '';
      document.getElementById('tcOutput').value = tc.output_data || '';
      document.getElementById('tcScore').value = tc.score;
      document.getElementById('tcTimeLimit').value = tc.time_limit || '';
      document.getElementById('tcMemLimit').value = tc.memory_limit || '';
      document.getElementById('tcGroup').value = tc.group_id || '';
      document.getElementById('tcEditor').classList.remove('hidden');
      updateGroupSelect();
    }

    function cancelEditTC() {
      document.getElementById('tcEditor').classList.add('hidden');
      editingTcId = null;
    }

    async function saveTestCase() {
      const input = document.getElementById('tcInput').value;
      const output = document.getElementById('tcOutput').value;
      const score = parseFloat(document.getElementById('tcScore').value) || 0;
      const timeLimit = document.getElementById('tcTimeLimit').value;
      const memLimit = document.getElementById('tcMemLimit').value;
      const group_id = document.getElementById('tcGroup').value || null;

      if (editingTcId) {
        await apiCall('PUT', `/problems/${currentProblemId}/testcases/${editingTcId}`, {
          input_data: input, output_data: output, score, group_id,
          time_limit: timeLimit ? parseInt(timeLimit) : null,
          memory_limit: memLimit ? parseInt(memLimit) : null
        });
      } else {
        await apiCall('POST', `/problems/${currentProblemId}/testcases`, { test_cases: [{
          input_data: input, output_data: output, score, group_id,
          time_limit: timeLimit ? parseInt(timeLimit) : null,
          memory_limit: memLimit ? parseInt(memLimit) : null
        }] });
      }
      cancelEditTC();
      await loadTestCases();
    }

    async function deleteSingleTC(tcid) {
      if (!confirm('确定删除此测试点？')) return;
      try {
        await apiCall('DELETE', `/problems/${currentProblemId}/testcases/${tcid}`);
        await loadTestCases();
      } catch (err) { showToast(err.message, 'error'); }
    }

    function batchAddTestCases() {
      const data = prompt('批量添加测试点（JSON 数组）：\n\n[{"input_data":"1 2","output_data":"3","score":25,"group_id":1},...]');
      if (!data) return;
      try {
        const arr = JSON.parse(data);
        apiCall('POST', `/problems/${currentProblemId}/testcases`, { test_cases: arr }).then(r => {
          showToast(r.message, 'success');
          loadTestCases();
        }).catch(e => showToast(e.message, 'error'));
      } catch (e) { showToast('JSON 格式错误: ' + e.message, 'error'); }
    }

    async function aiGenerateTestdata() {
      if (!currentProblemId) { showToast('请先选择题目', 'info'); return; }
      const samples = prompt('普通样例数量（1-10，默认 3）：', '3');
      if (samples === null) return;
      const edgeCases = prompt('边界测试点数量（0-10，默认 3）：', '3');
      if (edgeCases === null) return;
      try {
        const res = await apiCall('POST', `/problems/${currentProblemId}/ai-testdata`, {
          samples: parseInt(samples) || 3,
          edge_cases: parseInt(edgeCases) || 3
        });
        showToast(res.message, 'success');
        loadTestCases();
      } catch (err) { showToast(err.message || 'AI 生成失败', 'error'); }
    }

    async function uploadZip(file) {
      if (!file) return;
      if (!currentProblemId) { showToast('请先选择题目', 'info'); return; }
      if (!file.name.toLowerCase().endsWith('.zip')) { showToast('请上传 .zip 文件', 'info'); return; }
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`/api/v1/problems/${currentProblemId}/testdata-zip`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${getToken()}` },
          credentials: 'include',
          body: formData
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            clearToken();
            window.location.href = '/pages/login.html';
            return;
          }
          throw new Error(data.message || '上传失败');
        }
        showToast(data.message || '上传成功', 'success');
        await loadGroups();
        await loadTestCases();
      } catch (err) {
        showToast(err.message || '上传失败', 'error');
      }
      document.getElementById('zipInput').value = '';
    }

    // ── R12-2/R12-3: 用户管理工具条(创建用户 / Excel 导入 / 注册开关, 仅超管) ──
    let userToolsInited = false;
    function initUserAdminTools() {
      const currentUser = getUser();
      const isSu = currentUser && currentUser.role === 'su';
      const tools = document.getElementById('userAdminTools');
      if (!tools) return;
      tools.classList.toggle('hidden', !isSu);
      tools.classList.toggle('flex', isSu);
      if (!isSu || userToolsInited) return;
      userToolsInited = true;
      const wrap = document.getElementById('registerToggleWrap');
      wrap.classList.remove('hidden');
      wrap.classList.add('inline-flex');
      refreshRegisterToggle();
    }
    async function refreshRegisterToggle() {
      try {
        const data = await apiCall('GET', '/users/register-enabled');
        paintRegisterToggle(data.enabled);
      } catch { document.getElementById('registerToggleBtn').textContent = '?'; }
    }
    function paintRegisterToggle(enabled) {
      const btn = document.getElementById('registerToggleBtn');
      btn.dataset.enabled = enabled ? '1' : '0';
      btn.textContent = enabled ? '已开放' : '已关闭';
      btn.className = 'font-semibold ' + (enabled ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400');
    }
    async function toggleRegister() {
      const btn = document.getElementById('registerToggleBtn');
      const next = btn.dataset.enabled !== '1';
      if (!confirm(next ? '确定开放访客自行注册？' : '确定关闭自行注册？此后新用户只能由超管创建。')) return;
      try {
        const res = await apiCall('PUT', '/users/register-enabled', { enabled: next });
        paintRegisterToggle(res.enabled);
      } catch (err) { showToast(err.message || '操作失败', 'error'); refreshRegisterToggle(); }
    }

    function showCreateUser() {
      document.getElementById('createUserTitle').textContent = '创建用户';
      document.getElementById('createUserBtn').textContent = '创建';
      document.getElementById('cUsername').value = '';
      document.getElementById('cNickname').value = '';
      document.getElementById('cPassword').value = genPassword();
      document.getElementById('cRole').value = 'user';
      document.getElementById('importProgress').classList.add('hidden');
      document.getElementById('createUserForm').classList.remove('hidden');
    }
    function hideCreateUser() { document.getElementById('createUserForm').classList.add('hidden'); }
    function genPassword() {
      // 随机强密码: 10 位, 含大小写/数字/符号
      const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghjkmnpqrstuvwxyz', '23456789', '!@#$%'];
      let out = sets.map(s => s[Math.floor(Math.random() * s.length)]).join('');
      const all = sets.join('');
      while (out.length < 10) out += all[Math.floor(Math.random() * all.length)];
      return out.split('').sort(() => Math.random() - 0.5).join('');
    }
    async function createUser(silent) {
      const data = {
        username: document.getElementById('cUsername').value.trim(),
        nickname: document.getElementById('cNickname').value.trim(),
        password: document.getElementById('cPassword').value,
        role: document.getElementById('cRole').value
      };
      try {
        await apiCall('POST', '/users', data);
        if (!silent) {
          hideCreateUser();
          showToast(`用户 ${data.username} 创建成功\n初始密码: ${data.password}\n请妥善保存并转告用户首次登录后修改。`, 'success');
        }
        loadUsers();
        return true;
      } catch (err) {
        if (!silent) showToast(err.message || '创建失败', 'error');
        throw err;
      }
    }

    // Excel 导入: SheetJS 解析 → 表头映射(中英文) → 逐个调创建接口 → 结果汇总
    const ROLE_ALIAS = { 'user': 'user', 'teacher': 'teacher', 'admin': 'admin', 'su': 'su',
      '用户': 'user', '学生': 'user', '教师': 'teacher', '老师': 'teacher', '管理员': 'admin', '超级管理员': 'su' };
    const HEADER_ALIAS = {
      'username': 'username', '用户名': 'username', '账号': 'username',
      'password': 'password', '密码': 'password', '初始密码': 'password',
      'nickname': 'nickname', '昵称': 'nickname', '姓名': 'nickname',
      'role': 'role', '角色': 'role', '权限': 'role'
    };
    async function handleExcelImport(input) {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      if (typeof XLSX === 'undefined') { showToast('Excel 解析库未加载, 请检查网络后刷新重试', 'error'); return; }
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
        if (!rows.length) { showToast('表格为空', 'error'); return; }
        // 表头映射: 首行按列名识别; 无法识别表头时按固定顺序 用户名|密码|昵称|角色
        let map = {};
        const head = rows[0].map(c => String(c).trim().toLowerCase());
        const recognized = head.some(h => HEADER_ALIAS[h]);
        if (recognized) {
          head.forEach((h, i) => { if (HEADER_ALIAS[h]) map[HEADER_ALIAS[h]] = i; });
        } else {
          // 无表头: 按固定列序 用户名|密码|昵称|角色
          map = { username: 0, password: 1, nickname: 2, role: 3 };
        }
        if (map.username === undefined || map.password === undefined) { showToast('缺少「用户名」或「密码」列', 'error'); return; }
        const users = rows.slice(recognized ? 1 : 0).map(r => ({
          username: String(r[map.username] ?? '').trim(),
          password: String(r[map.password] ?? '').trim(),
          nickname: map.nickname !== undefined ? String(r[map.nickname] ?? '').trim() : '',
          role: ROLE_ALIAS[String(r[map.role] ?? '').trim()] || 'user'
        })).filter(u => u.username && u.password);
        if (!users.length) { showToast('未解析到有效数据行 (需要用户名与密码两列)', 'error'); return; }
        if (!confirm(`解析到 ${users.length} 个账号，确认批量创建？`)) return;

        const prog = document.getElementById('importProgress');
        prog.classList.remove('hidden');
        let ok = 0; const failed = [];
        for (const u of users) {
          try {
            await apiCall('POST', '/users', u);
            ok++;
          } catch (err) {
            failed.push(`${u.username}: ${err.message || '失败'}`);
          }
          prog.innerHTML = `导入中… ${ok + failed.length}/${users.length} (成功 ${ok}, 失败 ${failed.length})`;
        }
        prog.innerHTML = `<b>导入完成</b>: 成功 ${ok} 个${failed.length ? `, 失败 ${failed.length} 个:<br>` + failed.map(f => `<span class="text-red-500 dark:text-red-400">${escapeHtml(f)}</span>`).join('<br>') : ''}`;
        loadUsers();
      } catch (err) {
        showToast('Excel 解析失败: ' + (err.message || err), 'error');
      }
    }

    let usersPage = 1;
    async function loadUsers(page) {
      if (page) usersPage = page;
      const currentUser = getUser();
      const isSu = currentUser && currentUser.role === 'su';
      const hierarchy = ['user', 'teacher', 'admin', 'su'];
      const myLevel = hierarchy.indexOf(currentUser?.role || '');
      try {
        // 后端 parsePageLimit 把 limit 硬封顶在 100，之前固定拉第一页且没有翻页控件，
        // 第 101 位之后的用户在管理台里根本看不到、也搜不到
        const data = await apiCall('GET', `/users?page=${usersPage}&limit=100`);
        if (!data.users.length && usersPage > 1) {
          return loadUsers(usersPage - 1);
        }
        const total = data.total || data.users.length;
        const pageSize = data.limit || 100;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const pager = document.getElementById('usersPager');
        if (pager) {
          const btn = (target, label) => `
            <button ${target < 1 || target > totalPages ? 'disabled' : ''} onclick="loadUsers(${target})"
              class="px-3 py-1 rounded-lg border border-gray-300 dark:border-gray-600 ${target < 1 || target > totalPages ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-700'} text-gray-700 dark:text-gray-300">${label}</button>`;
          pager.innerHTML = `
            <span class="text-gray-500 dark:text-gray-400">共 ${total} 位用户 · 第 ${usersPage}/${totalPages} 页</span>
            <span class="space-x-2">${btn(usersPage - 1, '上一页')}${btn(usersPage + 1, '下一页')}</span>`;
        }
        document.getElementById('adminUsers').innerHTML = data.users.map(u => {
          const targetLevel = hierarchy.indexOf(u.role);
          const canOperate = u.id !== currentUser.id && myLevel > targetLevel;
          return `
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700 dark:bg-gray-700">
            <td class="px-4 py-3 text-sm">${u.id}</td>
            <td class="px-4 py-3 text-sm font-medium"><a href="profile.html?id=${u.id}" class="text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(u.username)}</a></td>
            <td class="px-4 py-3 text-sm"><a href="profile.html?id=${u.id}" class="text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(u.nickname)}</a></td>
            <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">${u.email ? escapeHtml(u.email) : '<span class="text-gray-300 dark:text-gray-600">-</span>'}</td>
            <td class="px-4 py-3 text-center">
              ${isSu && u.id !== currentUser.id ? `
                <select onchange="changeRole(${u.id}, this.value)" aria-label="${escapeHtml(u.username || u.nickname || '用户')} 的角色" class="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 outline-none dark:bg-gray-800 dark:text-white">
                  <option value="user" ${u.role==='user'?'selected':''}>用户</option>
                  <option value="teacher" ${u.role==='teacher'?'selected':''}>教师</option>
                  <option value="admin" ${u.role==='admin'?'selected':''}>管理员</option>
                  <option value="su" ${u.role==='su'?'selected':''}>超级管理员</option>
                </select>
              ` : roleBadge(u.role)}
            </td>
            <td class="px-4 py-3 text-center text-sm">${u.rating || 1500}</td>
            <td class="px-4 py-3 text-center">${u.banned ? '<span class="text-red-600 dark:text-red-400 text-sm">已封禁</span>' : '<span class="text-green-600 dark:text-green-400 text-sm">正常</span>'}</td>
            <td class="px-4 py-3 text-center">
              ${isSu || (currentUser.role === 'admin' && (hierarchy.indexOf(u.role) < myLevel || u.id === currentUser.id)) ? `
                <button onclick="toggleHideRating(${u.id}, ${u.hide_rating ? 0 : 1})" class="text-xs px-2 py-1 rounded ${u.hide_rating ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300' : 'bg-gray-100 text-gray-600 dark:text-gray-400 dark:text-gray-500'} hover:opacity-80">
                  ${u.hide_rating ? '已隐藏' : '显示'}
                </button>
              ` : (u.hide_rating ? '<span class="text-xs text-yellow-600 dark:text-yellow-400">已隐藏</span>' : '<span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">显示</span>')}
            </td>
            <td class="px-4 py-3 text-center space-x-1">
              ${isSu ? `<button onclick="setRating(${u.id})" class="text-yellow-600 dark:text-yellow-400 text-xs hover:underline">Rating</button>` : ''}
              ${canOperate ? (u.banned ? `<button onclick="unbanUser(${u.id})" class="text-green-600 dark:text-green-400 text-xs hover:underline">解封</button>` : `<button onclick="banUser(${u.id})" class="text-red-600 dark:text-red-400 text-xs hover:underline">封禁</button>`) : ''}
              ${canOperate ? `<button onclick="forceLogout(${u.id})" class="text-orange-600 dark:text-orange-400 text-xs hover:underline">登出</button>` : ''}
              ${isSu ? `<button onclick="resetPassword(${u.id})" class="text-blue-600 dark:text-blue-400 text-xs hover:underline">重置密码</button>` : ''}
              ${isSu && u.id !== currentUser.id ? `<button data-sudo-id="${u.id}" data-sudo-name="${escapeHtml(u.username)}" class="sudo-login-btn text-purple-600 dark:text-purple-400 text-xs hover:underline">免密</button>` : ''}
              ${isSu && u.id !== currentUser.id ? `<button onclick="deleteUser(${u.id})" class="text-red-600 dark:text-red-400 text-xs hover:underline">删除</button>` : ''}
              ${isSu && u.id !== currentUser.id ? `<button onclick="toggleSubmitExempt(${u.id}, ${u.submit_lock_exempt ? 0 : 1})" class="text-xs hover:underline ${u.submit_lock_exempt ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}">${u.submit_lock_exempt ? '已豁免' : '豁免'}</button>` : ''}
              ${isSu ? `<button onclick="setUploadLimits(${u.id})" class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">图床</button>` : ''}
            </td>
          </tr>
        `}).join('');
        // D-H5: sudo 按钮改用 data-* + 事件委托，杜绝内联 onclick 用户名注入
        document.querySelectorAll('#adminUsers .sudo-login-btn').forEach(btn => {
          btn.addEventListener('click', () => sudoLogin(parseInt(btn.dataset.sudoId, 10), btn.dataset.sudoName || `#${btn.dataset.sudoId}`));
        });
      } catch (err) { console.error(err); }
    }

    async function changeRole(uid, role) {
      if (!confirm(`确定将用户 #${uid} 的角色更改为 ${role}？`)) { loadUsers(); return; }
      try {
        await apiCall('PUT', `/users/${uid}/role`, { role });
        loadUsers();
      } catch (err) { showToast(err.message, 'error'); loadUsers(); }
    }

    async function setRating(uid) {
      const rating = prompt('设置 Rating 值（整数）：');
      if (rating === null) return;
      try {
        await apiCall('PUT', `/users/${uid}/rating`, { rating: parseInt(rating) || 0 });
        await refreshUser();
        document.getElementById('nav').innerHTML = renderNav('admin');
        loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function toggleHideRating(uid, hide) {
      try {
        await apiCall('PUT', `/users/${uid}/hide-rating`, { hide_rating: hide });
        loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function loadAdminArticles() {
      try {
        const data = await apiCall('GET', '/articles?limit=100');
        const el = document.getElementById('adminArticles');
        if (data.articles.length === 0) { el.innerHTML = '<div class="text-gray-400 dark:text-gray-500 dark:text-gray-400 py-4 text-center">暂无文章</div>'; return; }
        el.innerHTML = data.articles.map(a => `
          <div class="flex items-center justify-between p-4 bg-white dark:bg-gray-800 rounded-xl shadow-sm dark:shadow-gray-900/30 border border-gray-100 dark:border-gray-700">
            <div>
              <a href="/pages/article.html?id=${a.id}" class="font-medium text-gray-900 dark:text-white hover:text-indigo-600 dark:text-indigo-400">${escapeHtml(a.title)}</a>
              <div class="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-1"><a href="profile.html?id=${a.author_id}" class="text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(a.nickname || a.username)}</a> · ${new Date(a.created_at).toLocaleString()} ${a.is_published ? '' : '<span class="text-yellow-600 dark:text-yellow-400">未发布</span>'}</div>
            </div>
            <div class="flex space-x-2">
              <a href="/pages/article-edit.html?id=${a.id}" class="text-indigo-600 dark:text-indigo-400 text-sm hover:underline">编辑</a>
              <button onclick="deleteArticle(${a.id})" class="text-red-600 dark:text-red-400 text-sm hover:underline">删除</button>
            </div>
          </div>
        `).join('');
      } catch (err) { console.error(err); }
    }

    async function deleteArticle(id) {
      if (!confirm('确定删除此文章？')) return;
      try { await apiCall('DELETE', `/articles/${id}`); loadAdminArticles(); } catch (err) { showToast(err.message, 'error'); }
    }

    async function loadAdminFiles() {
      try {
        const data = await apiCall('GET', '/uploads?limit=100');
        const el = document.getElementById('adminFiles');
        if (!data.files || data.files.length === 0) { el.innerHTML = '<div class="text-gray-400 dark:text-gray-500 dark:text-gray-400 py-4 text-center">暂无文件</div>'; return; }
        el.innerHTML = data.files.map(f => `
          <div class="flex items-center justify-between p-4 bg-white dark:bg-gray-800 rounded-xl shadow-sm dark:shadow-gray-900/30 border border-gray-100 dark:border-gray-700">
            <div class="flex items-center space-x-3">
              <span class="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">#${f.id}</span>
              <a href="/uploads/${encodeURIComponent(f.filename)}" target="_blank" class="text-indigo-600 dark:text-indigo-400 text-sm hover:underline">${escapeHtml(f.original_name)}</a>
              <span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">${(f.size/1024).toFixed(1)}KB · <a href="profile.html?id=${f.user_id}" class="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">${escapeHtml(f.username || '匿名')}</a></span>
              <span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">${new Date(f.created_at).toLocaleString()}</span>
            </div>
            <button data-id="${f.id}" data-filename="${encodeURIComponent(f.filename)}" class="delete-file-btn text-red-600 dark:text-red-400 text-sm hover:underline">删除</button>
          </div>
        `).join('');
        // 10.3: 不用内联 onclick 拼接用户数据，改 data-* + 事件委托
        el.querySelectorAll('.delete-file-btn').forEach(btn => {
          btn.onclick = () => {
            const id = Number(btn.dataset.id);
            const filename = decodeURIComponent(btn.dataset.filename);
            deleteFile(id, filename);
          };
        });
      } catch (err) { console.error(err); }
    }

    async function deleteFile(id, _filename) {
      if (!confirm('确定删除此文件？')) return;
      try { await apiCall('DELETE', `/uploads/${id}`); loadAdminFiles(); } catch (err) { showToast(err.message, 'error'); }
    }

async function banUser(id) { try { await apiCall('POST', `/users/${id}/ban`); loadUsers(); } catch (err) { showToast(err.message, 'error'); } }
    async function toggleSubmitExempt(id, val) {
      try { await apiCall('PUT', `/users/${id}/submit-lock-exempt`, { submit_lock_exempt: val }); loadUsers(); } catch (err) { showToast(err.message, 'error'); }
    }
    async function setUploadLimits(id) {
      const maxFileSize = prompt('单文件大小限制（字节，0=默认10MB）：', '0');
      if (maxFileSize === null) return;
      const maxStorage = prompt('总存储限制（字节，0=默认2GB）：', '0');
      if (maxStorage === null) return;
      try {
        await apiCall('PUT', `/users/${id}/upload-limits`, { max_file_size: parseInt(maxFileSize) || 0, max_storage: parseInt(maxStorage) || 0 });
        showToast('已更新', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    }
    async function unbanUser(id) {
      if (!confirm('确定解封此用户？')) return;
      try { await apiCall('POST', `/users/${id}/unban`); loadUsers(); } catch (err) { showToast(err.message, 'error'); }
    }
    async function forceLogout(id) {
      if (!confirm('确定强制登出此用户？')) return;
      try {
        const res = await apiCall('POST', `/users/${id}/force-logout`);
        showToast(res.message || '已强制登出', 'success');
        loadUsers();
      } catch (err) { showToast(err.message, 'error'); }
    }
    async function resetPassword(id) {
      const pwd = prompt('新密码（至少 6 位）：');
      if (!pwd) return;
      try { await apiCall('POST', `/users/${id}/reset-password`, { new_password: pwd }); showToast('密码已重置', 'success'); } catch (err) { showToast(err.message, 'error'); }
    }

    let currentContestId = null;

    async function loadContests() {
      try {
        const data = await apiCall('GET', '/contests?limit=100');
        adminContestsCache = data.contests;
        const user = getUser();
        const isAdmin = user && ['admin', 'su'].includes(user.role);
        document.getElementById('adminContests').innerHTML = data.contests.map(c => {
          const ended = new Date(c.end_time).getTime() < Date.now();
          const frozen = c.freeze_minutes > 0 && !c.unfrozen && ended;
          const freezeBadge = c.freeze_minutes > 0
            ? (c.unfrozen
                ? '<span class="ml-1 px-1.5 py-0.5 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">已解冻</span>'
                : (frozen
                    ? '<span class="ml-1 px-1.5 py-0.5 text-xs rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300">冻结中</span>'
                    : '<span class="ml-1 px-1.5 py-0.5 text-xs rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">冻结' + c.freeze_minutes + 'min</span>'))
            : '';
          return `
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700 dark:bg-gray-700">
            <td class="px-4 py-3 text-sm">${c.id}</td>
            <td class="px-4 py-3 text-sm font-medium">${escapeHtml(c.title)}${freezeBadge}</td>
            <td class="px-4 py-3 text-center text-sm">${c.problem_count || 0}</td>
            <td class="px-4 py-3 text-center text-sm">${new Date(c.start_time).toLocaleString()}</td>
            <td class="px-4 py-3 text-center text-sm">${new Date(c.end_time).toLocaleString()}</td>
            <td class="px-4 py-3 text-center">
              <button onclick="showContestProblemManager(${c.id})" class="text-green-600 dark:text-green-400 text-sm hover:underline mr-2">管理题目</button>
              <button onclick="startContestPlagiarismCheck(${c.id})" class="text-purple-600 dark:text-purple-400 text-sm hover:underline mr-2" title="一键全部查重">一键查重</button>
              ${isAdmin && c.freeze_minutes > 0 && !c.unfrozen ? `<button onclick="unfreezeContest(${c.id})" class="text-yellow-600 dark:text-yellow-400 text-sm hover:underline mr-2">解冻</button>` : ''}
              <button onclick="deleteContest(${c.id})" class="text-red-600 dark:text-red-400 text-sm hover:underline">删除</button>
            </td>
          </tr>
        `;}).join('');
      } catch (err) { console.error(err); }
    }

    // 比赛没有编辑表单，可见性只在创建流程里设置；如需改可见性请删掉重建或另加编辑入口
    async function createContest() {
      try {
        const created = await apiCall('POST', '/contests', {
          title: document.getElementById('cTitle').value,
          start_time: localInputToIso(document.getElementById('cStart').value),
          end_time: localInputToIso(document.getElementById('cEnd').value),
          freeze_minutes: parseInt(document.getElementById('cFreeze').value) || 0,
        });
        hideCreateContest();
        loadContests();
        // 比赛主数据已保存，再补可见性（失败仅 toast，不回滚）
        if (created && created.id) await saveEntityVisibility('contests', created.id, 'cVisibility', 'cVisibilityGroups');
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function deleteContest(id) {
      if (!confirm('确定删除此比赛？')) return;
      try { await apiCall('DELETE', `/contests/${id}`); loadContests(); } catch (err) { showToast(err.message, 'error'); }
    }

    async function unfreezeContest(id) {
      if (!confirm('确定解冻此比赛排行榜？解冻后将展示最终排名。')) return;
      try {
        await apiCall('POST', `/contests/${id}/unfreeze`);
        showToast('已解冻', 'success');
        loadContests();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function showContestProblemManager(cid) {
      currentContestId = cid;
      document.getElementById('contestProblemManager').classList.remove('hidden');
      const cached = (adminContestsCache.find(x => x.id === cid) || { title: '' }).title;
      document.getElementById('contestProblemTitle').textContent = `管理比赛 - #${cid} ${cached}`;
      await Promise.all([loadContestProblems(), loadContestParticipants()]);
    }

    function hideContestProblemManager() {
      document.getElementById('contestProblemManager').classList.add('hidden');
      currentContestId = null;
    }

    async function loadContestParticipants() {
      try {
        const data = await apiCall('GET', `/contests/${currentContestId}/participants`);
        document.getElementById('participantCount').textContent = data.total;
        const el = document.getElementById('participantList');
        if (data.participants.length === 0) {
          el.innerHTML = '<div class="text-sm text-gray-400 dark:text-gray-500 dark:text-gray-400 py-1">暂无参赛用户</div>';
          return;
        }
        el.innerHTML = data.participants.map(p => `
          <div class="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <div class="flex items-center space-x-3">
              <span class="text-sm font-mono text-gray-500 dark:text-gray-400 dark:text-gray-500">#${p.user_id}</span>
              <span class="text-sm font-medium"><a href="profile.html?id=${p.user_id}" class="text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(p.nickname || p.username)}</a></span>
              ${roleBadge(p.role)}
              ${p.invited_by_name ? `<span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">被 ${escapeHtml(p.invited_by_name)} 邀请</span>` : '<span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">自行加入</span>'}
            </div>
            <button onclick="removeContestParticipant(${p.user_id})" class="text-xs text-red-600 dark:text-red-400 hover:underline">移除</button>
          </div>
        `).join('');
      } catch (err) { console.error(err); }
    }

    async function inviteContestUser() {
      const userId = parseInt(document.getElementById('cpUserId').value);
      if (!userId) { showToast('请输入用户 ID', 'error'); return; }
      try {
        await apiCall('POST', `/contests/${currentContestId}/invite`, { user_id: userId });
        document.getElementById('cpUserId').value = '';
        await loadContestParticipants();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function removeContestParticipant(uid) {
      if (!confirm('确定移除此用户？')) return;
      try {
        await apiCall('DELETE', `/contests/${currentContestId}/participants/${uid}`);
        await loadContestParticipants();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function loadContestProblems() {
      try {
        const data = await apiCall('GET', `/contests/${currentContestId}`);
        const el = document.getElementById('contestProblemsList');
        if (!data.problems || data.problems.length === 0) {
          el.innerHTML = '<div class="text-sm text-gray-400 dark:text-gray-500 dark:text-gray-400 py-2">暂无题目</div>';
          return;
        }
        el.innerHTML = data.problems.map(p => `
          <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-xl">
            <div class="flex items-center space-x-3">
              <span class="text-sm font-mono text-indigo-600 dark:text-indigo-400">#${p.id}</span>
              <span class="text-sm font-medium">${escapeHtml(p.title)}</span>
              ${p.alias ? `<span class="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">别名: ${escapeHtml(p.alias)}</span>` : ''}
              ${p.is_public === 0 ? '<span class="text-xs px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 rounded">非公开</span>' : ''}
              <span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">排序: ${p.sort_order}</span>
            </div>
            <button onclick="removeContestProblem(${p.id})" class="text-xs text-red-600 dark:text-red-400 hover:underline">移除</button>
          </div>
        `).join('');
      } catch (err) { console.error(err); }
    }

    async function addContestProblem() {
      const problemId = parseInt(document.getElementById('cpProblemId').value);
      if (!problemId) { showToast('请输入题目 ID', 'error'); return; }
      const alias = document.getElementById('cpAlias').value.trim();
      try {
        await apiCall('POST', `/contests/${currentContestId}/problems`, { problem_id: problemId, alias: alias || undefined });
        document.getElementById('cpProblemId').value = '';
        document.getElementById('cpAlias').value = '';
        await loadContestProblems();
        loadContests();
      } catch (err) { showToast(err.message, 'error'); }
    }

    async function removeContestProblem(problemId) {
      if (!confirm('确定从此比赛中移除此题目？')) return;
      try {
        await apiCall('DELETE', `/contests/${currentContestId}/problems/${problemId}`);
        await loadContestProblems();
        loadContests();
      } catch (err) { showToast(err.message, 'error'); }
    }

    function showBatchSetModal() {
      document.getElementById('batchScore').value = '';
      document.getElementById('batchTimeLimit').value = '';
      document.getElementById('batchMemLimit').value = '';
      document.getElementById('batchSetModal').classList.remove('hidden');
    }

    function hideBatchSetModal() {
      document.getElementById('batchSetModal').classList.add('hidden');
    }

    async function applyBatchSettings() {
      if (!currentProblemId) { showToast('请先选择题目', 'info'); return; }
      const score = document.getElementById('batchScore').value;
      const timeLimit = document.getElementById('batchTimeLimit').value;
      const memLimit = document.getElementById('batchMemLimit').value;

      if (!score && !timeLimit && !memLimit) {
        showToast('请至少填写一项', 'error');
        return;
      }

      try {
        await apiCall('PUT', `/problems/${currentProblemId}/batch-testcases`, {
          score: score ? parseInt(score) : null,
          time_limit: timeLimit ? parseInt(timeLimit) : null,
          memory_limit: memLimit ? parseInt(memLimit) : null
        });
        hideBatchSetModal();
        await loadTestCases();
        showToast('批量设置已应用', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // 功能10：单题查重 - 发起后跳转到报告页轮询进度
    async function startPlagiarismCheck(problemId) {
      if (!confirm(`确定对题目 #${problemId} 发起代码查重？将比较所有用户的最新提交。`)) return;
      try {
        const res = await apiCall('POST', `/problems/${problemId}/plagiarism-check`);
        window.location.href = `/pages/plagiarism-report.html?problem=${problemId}&task=${res.task_id}`;
      } catch (err) {
        showToast(err.message || '发起查重失败', 'error');
      }
    }

    // 功能14：导出题目为 ZIP 下载
    async function exportProblem(problemId) {
      try {
        const res = await fetch(`/api/v1/problems/${problemId}/export?format=zip`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${getToken()}`, 'Origin': location.origin },
          credentials: 'include'
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.message || '导出失败');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `problem_${problemId}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        showToast(err.message || '导出失败', 'error');
      }
    }

    // 功能15：导入题目（ZIP 或 JSON）
    async function importProblem(file) {
      if (!file) return;
      if (!confirm('导入将创建一道新题目，确定继续？')) { document.getElementById('importProblemInput').value = ''; return; }
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/v1/problems/import', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${getToken()}`, 'Origin': location.origin },
          credentials: 'include',
          body: formData
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) { clearToken(); window.location.href = '/pages/login.html'; return; }
          throw new Error(data.message || '导入失败');
        }
        showToast(data.message, 'success');
        loadAdminProblems();
      } catch (err) {
        showToast(err.message || '导入失败', 'error');
      } finally {
        document.getElementById('importProblemInput').value = '';
      }
    }

    // 功能10：比赛一键查重 - 对比赛所有题目发起查重
    async function startContestPlagiarismCheck(contestId) {
      if (!confirm(`确定对比赛 #${contestId} 的所有题目一键查重？将在后台异步执行。`)) return;
      try {
        const res = await apiCall('POST', `/contests/${contestId}/plagiarism-check`);
        showToast(`已对 ${res.total} 道题目发起查重，可在题目管理点击"查重"查看各题进度。`, 'success');
      } catch (err) {
        showToast(err.message || '发起查重失败', 'error');
      }
    }

    // ── 用户组（实体可见性分组）─────────────────────────────
    // 命名一律带 UserGroup 前缀：本文件的 currentGroups/loadGroups/renderGroups/
    // showGroupEditor/saveGroup/deleteGroup 已被测试点(Subtask)分组占用，不能重名。
    let userGroupsCache = [];
    let editingUserGroupId = null;
    let currentUserGroupId = null;
    let userGroupMembersPage = 1;
    const USER_GROUP_SYSTEM_TIP = '系统组不可变更';

    function isSystemUserGroup(g) { return !!g && g.kind !== 'custom'; }

    function userGroupKindBadge(g) {
      if (g.kind === 'all_users') {
        return '<span class="px-2 py-0.5 text-xs rounded-full font-bold bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 ring-1 ring-amber-400" title="系统组：站内全部用户">所有用户</span>';
      }
      if (g.kind === 'personal') {
        return '<span class="px-2 py-0.5 text-xs rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" title="系统组：个人私有组">个人组</span>';
      }
      return '<span class="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">自定义</span>';
    }

    // 系统组的操作按钮渲染为 disabled + title 提示，UI 上不可操作
    function userGroupActionBtn(label, onclick, sys, cls) {
      const base = `text-xs hover:underline ${cls}`;
      if (sys) return `<button disabled title="${USER_GROUP_SYSTEM_TIP}" class="${base} opacity-40 cursor-not-allowed">${label}</button>`;
      return `<button onclick="${onclick}" class="${base}">${label}</button>`;
    }

    async function loadUserGroups() {
      const tbody = document.getElementById('userGroupList');
      try {
        const data = await apiCall('GET', '/groups');
        // 兼容裸数组与 {groups:[...]} 两种返回
        userGroupsCache = Array.isArray(data) ? data : (data.groups || data.data || []);
        renderUserGroups();
      } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-6 text-center text-sm text-red-500 dark:text-red-400">${escapeHtml(err.message) || '加载失败'}</td></tr>`;
      }
    }

    function renderUserGroups() {
      const tbody = document.getElementById('userGroupList');
      renderUserGroupImportTargets();
      if (!tbody) return;
      if (userGroupsCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-6 text-center text-sm text-gray-400 dark:text-gray-500 dark:text-gray-400">暂无用户组</td></tr>';
        return;
      }
      tbody.innerHTML = userGroupsCache.map(g => {
        const sys = isSystemUserGroup(g);
        const owner = g.kind === 'personal' ? `<span class="ml-1 text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">用户 #${g.owner_id ?? ''}</span>` : '';
        const desc = g.description
          ? escapeHtml(g.description)
          : '<span class="text-gray-300 dark:text-gray-600">-</span>';
        return `
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700">
            <td class="px-4 py-3 text-sm">${g.id}</td>
            <td class="px-4 py-3 text-sm font-medium">${escapeHtml(g.name || '')}${owner}</td>
            <td class="px-4 py-3 text-center">${userGroupKindBadge(g)}</td>
            <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">${desc}</td>
            <td class="px-4 py-3 text-center text-sm">${g.member_count || 0}</td>
            <td class="px-4 py-3 text-center text-sm ${g.resource_count ? 'text-orange-600 dark:text-orange-400' : ''}">${g.resource_count || 0}</td>
            <td class="px-4 py-3 text-center space-x-2 whitespace-nowrap">
              ${userGroupActionBtn('改名/描述', `showUserGroupForm(${g.id})`, sys, 'text-blue-600 dark:text-blue-400')}
              ${userGroupActionBtn('成员', `openUserGroupMembers(${g.id})`, sys, 'text-indigo-600 dark:text-indigo-400')}
              ${userGroupActionBtn('删除', `deleteUserGroup(${g.id})`, sys, 'text-red-600 dark:text-red-400')}
            </td>
          </tr>
        `;
      }).join('');
    }

    function showUserGroupForm(gid) {
      const g = gid ? userGroupsCache.find(x => x.id === gid) : null;
      if (gid && isSystemUserGroup(g)) { showToast(USER_GROUP_SYSTEM_TIP, 'error'); return; }
      editingUserGroupId = gid || null;
      document.getElementById('userGroupFormTitle').textContent = g ? `编辑用户组 #${gid}` : '新建用户组';
      document.getElementById('userGroupSaveBtn').textContent = g ? '保存' : '创建';
      document.getElementById('ugName').value = g ? (g.name || '') : '';
      document.getElementById('ugDesc').value = g ? (g.description || '') : '';
      document.getElementById('createUserGroupForm').classList.remove('hidden');
    }

    function hideUserGroupForm() {
      document.getElementById('createUserGroupForm').classList.add('hidden');
      editingUserGroupId = null;
    }

    async function createUserGroup() {
      const name = document.getElementById('ugName').value.trim();
      const description = document.getElementById('ugDesc').value.trim();
      if (!name) { showToast('请输入组名', 'info'); return; }
      const btn = document.getElementById('userGroupSaveBtn');
      if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
      try {
        if (editingUserGroupId) {
          await apiCall('PUT', `/groups/${editingUserGroupId}`, { name, description });
          showToast('已保存', 'success');
        } else {
          await apiCall('POST', '/groups', { name, description });
          showToast('用户组已创建', 'success');
        }
        hideUserGroupForm();
        await loadUserGroups();
      } catch (err) { showToast(err.message || '操作失败', 'error'); }
      finally { if (btn) { btn.disabled = false; btn.textContent = editingUserGroupId ? '保存' : '创建'; } }
    }

    // force=1 时后端先把关联实体回退为 visibility='public' 再删组
    async function deleteUserGroup(id, force) {
      const g = userGroupsCache.find(x => x.id === id);
      if (isSystemUserGroup(g)) { showToast(USER_GROUP_SYSTEM_TIP, 'error'); return; }
      const label = g ? g.name : `#${id}`;
      const bound = (g && g.resource_count) || 0;
      if (force) {
        if (!confirm(`强制删除用户组「${label}」？\n该组关联的实体会被恢复为公开可见，此操作不可撤销。`)) return;
      } else if (bound > 0) {
        if (!confirm(`用户组「${label}」仍关联着 ${bound} 个实体，普通删除会被拒绝。\n是否强制删除（关联实体会恢复为公开）？`)) return;
        return deleteUserGroup(id, true);
      } else if (!confirm(`确定删除用户组「${label}」？此操作不可撤销。`)) return;

      try {
        await apiCall('DELETE', `/groups/${id}?force=${force ? 1 : 0}`);
        showToast('用户组已删除', 'success');
        if (editingUserGroupId === id) hideUserGroupForm();
        if (currentUserGroupId === id) closeUserGroupMembers();
        await loadUserGroups();
      } catch (err) {
        // 契约：绑定实体且 force 非 1 → 403/409 ERR_INVALID_STATE，message 里列出实体
        if (!force && err && err.reason === 'ERR_INVALID_STATE') {
          showToast(err.message || '该用户组仍绑定着实体', 'error');
          if (confirm('是否改用强制删除？\n强制删除会把关联实体的可见性恢复为公开。')) deleteUserGroup(id, true);
          return;
        }
        showToast(err.message || '操作失败', 'error');
      }
    }

    function openUserGroupMembers(id) {
      const g = userGroupsCache.find(x => x.id === id);
      if (isSystemUserGroup(g)) { showToast(USER_GROUP_SYSTEM_TIP, 'error'); return; }
      currentUserGroupId = id;
      document.getElementById('userGroupMembersTitle').textContent = `成员管理 - ${g ? g.name : '#' + id}`;
      document.getElementById('ugMembersHint').textContent = '按用户 ID 添加成员（后端按 user_id 匹配）';
      document.getElementById('userGroupMembers').classList.remove('hidden');
      loadUserGroupMembers(1);
    }

    function closeUserGroupMembers() {
      document.getElementById('userGroupMembers').classList.add('hidden');
      currentUserGroupId = null;
    }

    async function loadUserGroupMembers(page) {
      if (page) userGroupMembersPage = page;
      const gid = currentUserGroupId;
      if (!gid) return;
      const listEl = document.getElementById('userGroupMemberList');
      const pagerEl = document.getElementById('userGroupMembersPager');
      try {
        const data = await apiCall('GET', `/groups/${gid}/members?page=${userGroupMembersPage}&limit=20`);
        const members = Array.isArray(data) ? data : (data.members || data.users || []);
        const total = (data && data.total) || members.length;
        const pageSize = (data && (data.limit || data.page_size)) || 20;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (pagerEl) {
          const btn = (target, label) => `
            <button ${target < 1 || target > totalPages ? 'disabled' : ''} onclick="loadUserGroupMembers(${target})"
              class="px-3 py-1 rounded-lg border border-gray-300 dark:border-gray-600 ${target < 1 || target > totalPages ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-700'} text-gray-700 dark:text-gray-300">${label}</button>`;
          pagerEl.innerHTML = `
            <span class="text-gray-500 dark:text-gray-400 dark:text-gray-400">共 ${total} 位成员 · 第 ${userGroupMembersPage}/${totalPages} 页</span>
            <span class="space-x-2">${btn(userGroupMembersPage - 1, '上一页')}${btn(userGroupMembersPage + 1, '下一页')}</span>`;
        }
        if (members.length === 0) {
          listEl.innerHTML = '<div class="text-sm text-gray-400 dark:text-gray-500 dark:text-gray-400 py-2">暂无成员</div>';
          return;
        }
        const g = userGroupsCache.find(x => x.id === gid);
        const sys = isSystemUserGroup(g);
        listEl.innerHTML = members.map(m => {
          const uid = m.id != null ? m.id : m.user_id;
          const isOwner = !!g && g.kind === 'personal' && uid === g.owner_id;
          const removeCell = isOwner
            ? '<span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400" title="个人组成员恒为创建者，不可移除">所有者（只读）</span>'
            : userGroupActionBtn('移除', `removeUserGroupMember(${gid}, ${uid})`, sys, 'text-red-600 dark:text-red-400');
          return `
          <div class="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <div class="flex items-center space-x-3 flex-wrap">
              <span class="text-sm font-mono text-gray-500 dark:text-gray-400 dark:text-gray-400">#${uid}</span>
              <a href="profile.html?id=${uid}" class="text-indigo-600 dark:text-indigo-400 hover:underline">${escapeHtml(m.nickname || m.username || '')}</a>
              <span class="text-xs text-gray-400 dark:text-gray-500 dark:text-gray-400">@${escapeHtml(m.username || '')}</span>
              ${roleBadge(m.role)}
              ${isOwner ? '<span class="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">所有者</span>' : ''}
            </div>
            ${removeCell}
          </div>`;
        }).join('');
      } catch (err) {
        listEl.innerHTML = `<p class="text-sm text-red-500 dark:text-red-400 py-2">${escapeHtml(err.message) || '加载失败'}</p>`;
      }
    }

    // 契约：POST /groups/:id/members 只收 {user_id}，故这里只做 ID 输入
    async function addUserGroupMember() {
      const gid = currentUserGroupId;
      if (!gid) { showToast('请先打开某个用户组的成员管理', 'info'); return; }
      const g = userGroupsCache.find(x => x.id === gid);
      if (isSystemUserGroup(g)) { showToast(USER_GROUP_SYSTEM_TIP, 'error'); return; }
      const raw = document.getElementById('ugMemberId').value.trim();
      const userId = parseInt(raw, 10);
      if (!/^\d+$/.test(raw) || !(userId > 0)) { showToast('请输入有效的用户 ID', 'info'); return; }
      const btn = document.getElementById('ugAddMemberBtn');
      if (btn) { btn.disabled = true; btn.textContent = '添加中...'; }
      try {
        await apiCall('POST', `/groups/${gid}/members`, { user_id: userId });
        document.getElementById('ugMemberId').value = '';
        showToast('已添加成员', 'success');
        await loadUserGroupMembers();
        await loadUserGroups();
      } catch (err) { showToast(err.message || '操作失败', 'error'); }
      finally { if (btn) { btn.disabled = false; btn.textContent = '添加成员'; } }
    }

    async function removeUserGroupMember(gid, userId) {
      const g = userGroupsCache.find(x => x.id === gid);
      if (isSystemUserGroup(g)) { showToast(USER_GROUP_SYSTEM_TIP, 'error'); return; }
      if (!confirm('确定将该用户移出此用户组？')) return;
      try {
        await apiCall('DELETE', `/groups/${gid}/members/${userId}`);
        showToast('已移除成员', 'success');
        await loadUserGroupMembers();
        await loadUserGroups();
      } catch (err) { showToast(err.message || '操作失败', 'error'); }
    }

    // ── 用户组 Excel 导入（契约：POST /groups/:id/import，仅超级管理员）────────────
    const USER_GROUP_IMPORT_MAX = 500;
    const USER_GROUP_IMPORT_SU_TIP = '含未注册用户自动注册，需超级管理员';
    const USER_GROUP_IMPORT_PWD_RULE = '至少 8 位，且须同时包含字母与数字（或字母与符号）';
    const USER_GROUP_IMPORT_USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;
    // 表头别名：与 group-sample.xlsx「填写说明」一致（用户名/username/账号、昵称/nickname/姓名）
    const USER_GROUP_HEADER_ALIAS = {
      username: 'username', '用户名': 'username', '账号': 'username',
      nickname: 'nickname', '昵称': 'nickname', '姓名': 'nickname'
    };
    let userGroupImportRows = [];
    let userGroupImportGroupId = null;
    let userGroupImportSubmitting = false;

    function userGroupImportAllowed() {
      const me = getUser();
      return !!me && me.role === 'su';
    }

    // admin/su 可见该工具条；admin 的「Excel 导入」渲染为 disabled + title 说明原因，
    // 其它角色（理论上进不了本 tab）整块不渲染
    function initUserGroupImportTools() {
      const tools = document.getElementById('userGroupImportTools');
      if (!tools) return;
      const me = getUser();
      const role = me && me.role;
      if (role !== 'su' && role !== 'admin') { tools.classList.add('hidden'); return; }
      tools.classList.remove('hidden');
      tools.classList.add('flex');
      // 目标组下拉只有 su 用得上
      const label = document.getElementById('userGroupImportGroupLabel');
      const sel = document.getElementById('userGroupImportGroup');
      if (label) label.classList.toggle('hidden', role !== 'su');
      if (sel) sel.classList.toggle('hidden', role !== 'su');
      paintUserGroupImportBtn(false);
    }

    function paintUserGroupImportBtn(busy) {
      const btn = document.getElementById('userGroupImportBtn');
      if (!btn) return;
      const su = userGroupImportAllowed();
      btn.disabled = !!busy || !su;
      btn.classList.toggle('opacity-40', !su);
      btn.classList.toggle('cursor-not-allowed', !su || !!busy);
      btn.textContent = busy ? '解析中...' : 'Excel 导入';
      if (su) btn.removeAttribute('title');
      else btn.title = USER_GROUP_IMPORT_SU_TIP;
    }

    // 导入目标组来自工具条下拉（接口是按组的），只列自定义组：系统组不可导入
    function renderUserGroupImportTargets() {
      const sel = document.getElementById('userGroupImportGroup');
      if (!sel) return;
      const prev = sel.value;
      const options = userGroupsCache.filter(g => !isSystemUserGroup(g));
      sel.innerHTML = options.length
        ? options.map(g => `<option value="${g.id}">${escapeHtml(g.name || '')} (#${g.id})</option>`).join('')
        : '<option value="">暂无可导入的自定义组</option>';
      if (prev && options.some(g => String(g.id) === prev)) sel.value = prev;
    }

    function userGroupImportTargetId() {
      const sel = document.getElementById('userGroupImportGroup');
      const raw = sel ? String(sel.value || '') : '';
      if (!/^\d+$/.test(raw)) return null;
      const gid = parseInt(raw, 10);
      return gid > 0 ? gid : null;
    }

    // 与后端 default_password 同规则：≥8 位、含字母，且含数字或符号
    function isStrongUserGroupImportPwd(pw) {
      if (!pw || pw.length < 8) return false;
      if (!/[a-zA-Z]/.test(pw)) return false;
      return /\d/.test(pw) || /[^a-zA-Z0-9]/.test(pw);
    }

    // file input onchange 入口：解析 + 本地清洗/预检，通过后再问默认密码（绝不上传文件）
    async function handleUserGroupImportFile(input) {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      if (!userGroupImportAllowed()) { showToast(USER_GROUP_IMPORT_SU_TIP, 'error'); return; }
      if (typeof XLSX === 'undefined') { showToast('Excel 解析库未加载, 请检查网络后刷新重试', 'error'); return; }
      const gid = userGroupImportTargetId();
      if (!gid) { showToast('请先在「目标组」中选择要导入的用户组', 'info'); return; }
      const g = userGroupsCache.find(x => x.id === gid);
      if (isSystemUserGroup(g)) { showToast(USER_GROUP_SYSTEM_TIP, 'error'); return; }

      paintUserGroupImportBtn(true);
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        // 导入器只读第一个 sheet
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
        if (!rows.length) { showToast('表格为空', 'error'); return; }

        // 表头映射: 首行按列名识别; 无法识别表头时按固定列序 用户名|昵称
        let map = {};
        const head = rows[0].map(c => String(c).trim().toLowerCase());
        const recognized = head.some(h => USER_GROUP_HEADER_ALIAS[h]);
        if (recognized) {
          head.forEach((h, i) => { if (USER_GROUP_HEADER_ALIAS[h]) map[USER_GROUP_HEADER_ALIAS[h]] = i; });
        } else {
          map = { username: 0, nickname: 1 };
        }
        if (map.username === undefined) { showToast('缺少「用户名」列', 'error'); return; }

        // 行级清洗: 去空行、去重（保留首次）。本地能判的先给行号提示，
        // 但非法用户名等仍照原样发给后端——注册与最终校验由后端说了算。
        const users = [];
        const seen = new Set();
        const notices = [];
        rows.slice(recognized ? 1 : 0).forEach((r, i) => {
          const lineNo = (recognized ? 1 : 0) + i + 1;
          const username = String(r[map.username] ?? '').trim();
          const nickname = map.nickname !== undefined ? String(r[map.nickname] ?? '').trim() : '';
          if (!username && !nickname) return;
          if (!username) { notices.push(`第 ${lineNo} 行：缺少用户名，已跳过`); return; }
          if (seen.has(username)) { notices.push(`第 ${lineNo} 行：用户名「${username}」重复，已保留首次出现的行`); return; }
          seen.add(username);
          if (!USER_GROUP_IMPORT_USERNAME_RE.test(username)) {
            notices.push(`第 ${lineNo} 行：用户名「${username}」含非法字符（仅允许字母/数字/_/./-），仍会提交，由后端判失败`);
          }
          users.push(nickname ? { username, nickname } : { username });
        });
        if (!users.length) { showToast('未解析到有效数据行 (需要「用户名」列)', 'error'); return; }
        if (users.length > USER_GROUP_IMPORT_MAX) {
          showToast(`解析到 ${users.length} 行，超过单次导入上限 ${USER_GROUP_IMPORT_MAX} 行，请拆分后再导入`, 'error');
          return;
        }

        userGroupImportRows = users;
        userGroupImportGroupId = gid;
        openUserGroupImportModal(gid, users, notices);
      } catch (err) {
        showToast('Excel 解析失败: ' + (err.message || err), 'error');
      } finally {
        paintUserGroupImportBtn(false);
      }
    }

    function openUserGroupImportModal(gid, users, notices) {
      const g = userGroupsCache.find(x => x.id === gid);
      document.getElementById('groupImportModalTitle').textContent = `Excel 导入 - ${g ? g.name : '#' + gid}`;
      document.getElementById('groupImportSummary').textContent =
        `已解析 ${users.length} 行，目标用户组「${g ? g.name : '#' + gid}」；单次上限 ${USER_GROUP_IMPORT_MAX} 行。`;
      const noticeBox = document.getElementById('groupImportNotices');
      const list = notices || [];
      noticeBox.classList.toggle('hidden', !list.length);
      if (list.length) noticeBox.innerHTML = list.map(n => `<div>${escapeHtml(n)}</div>`).join('');
      const pwd = document.getElementById('groupImportPassword');
      const pwd2 = document.getElementById('groupImportPassword2');
      pwd.value = '';
      pwd2.value = '';
      document.getElementById('groupImportModal').classList.remove('hidden');
      document.addEventListener('keydown', onUserGroupImportKeydown);
      updateUserGroupImportStrength();
      pwd.focus();
    }

    function closeUserGroupImportModal() {
      const modal = document.getElementById('groupImportModal');
      if (modal) modal.classList.add('hidden');
      document.removeEventListener('keydown', onUserGroupImportKeydown);
      // 取消即丢弃本次解析结果，不发任何请求；顺带清掉 DOM 里的明文
      userGroupImportRows = [];
      userGroupImportGroupId = null;
      const pwd = document.getElementById('groupImportPassword');
      const pwd2 = document.getElementById('groupImportPassword2');
      if (pwd) pwd.value = '';
      if (pwd2) pwd2.value = '';
      const noticeBox = document.getElementById('groupImportNotices');
      if (noticeBox) { noticeBox.innerHTML = ''; noticeBox.classList.add('hidden'); }
      paintUserGroupImportSubmitBtn(false);
    }

    function onUserGroupImportKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeUserGroupImportModal(); }
    }

    // 实时强度提示：两个输入框的 input 事件都调它；不合规/不一致时禁用确认按钮
    function updateUserGroupImportStrength() {
      const pwd = document.getElementById('groupImportPassword').value;
      const pwd2 = document.getElementById('groupImportPassword2').value;
      const hint = document.getElementById('groupImportStrength');
      const touched = !!pwd || !!pwd2;
      let ok = false;
      let msg = `密码要求：${USER_GROUP_IMPORT_PWD_RULE}`;
      if (touched) {
        if (!isStrongUserGroupImportPwd(pwd)) msg = `密码强度不足：${USER_GROUP_IMPORT_PWD_RULE}`;
        else if (pwd2 && pwd2 !== pwd) msg = '两次输入的密码不一致';
        else if (!pwd2) msg = `强度合格，请再输入一次确认（${USER_GROUP_IMPORT_PWD_RULE}）`;
        else { msg = '强度合格，可以开始导入'; ok = true; }
      }
      hint.textContent = msg;
      hint.className = 'text-xs ' + (ok
        ? 'text-green-600 dark:text-green-400'
        : (touched ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'));
      paintUserGroupImportSubmitBtn(ok);
    }

    // 确认按钮：可提交才给 hover 反馈，禁用态统一 opacity-40 + not-allowed
    function paintUserGroupImportSubmitBtn(ok) {
      const btn = document.getElementById('groupImportSubmitBtn');
      if (!btn) return;
      const enabled = !!ok && !userGroupImportSubmitting;
      btn.disabled = !enabled;
      btn.className = 'px-4 py-2 text-white rounded-lg bg-indigo-600 ' +
        (enabled ? 'hover:bg-indigo-700' : 'opacity-40 cursor-not-allowed');
    }

    function userGroupImportSummaryText(res) {
      const total = (res && res.total) || 0;
      const added = (res && res.added) || 0;
      const registered = (res && res.registered) || 0;
      const skipped = (res && res.skipped) || 0;
      return `共 ${total} 行：新增成员 ${added} 人（其中自动注册 ${registered} 人），已在组内 ${skipped} 人`;
    }

    function renderUserGroupImportResult(res) {
      const prog = document.getElementById('groupImportProgress');
      if (!prog) return;
      const failed = (res && Array.isArray(res.failed)) ? res.failed : [];
      const summary = userGroupImportSummaryText(res);
      prog.classList.remove('hidden');
      prog.innerHTML = `<b>导入完成</b>: ${escapeHtml(summary)}` + (failed.length
        ? `<br>失败 ${failed.length} 条:<br>` + failed.map(f =>
          `<span class="text-red-500 dark:text-red-400">${escapeHtml(`${f.username || ''}: ${f.reason || '失败'}`)}</span>`).join('<br>')
        : '');
      showToast(failed.length
        ? `${summary}\n失败 ${failed.length} 条，明细见下方结果框`
        : summary, failed.length ? 'info' : 'success');
    }

    // 契约：{ users:[{username, nickname?}], default_password? }，整单 200/400，
    // 行级失败在响应 failed 里，403 = 系统组 或 非 su
    async function submitUserGroupImport() {
      if (userGroupImportSubmitting) return;
      const gid = userGroupImportGroupId;
      const users = userGroupImportRows;
      if (!gid || !users.length) { showToast('请先选择要导入的 Excel 文件', 'info'); return; }
      const pwd = document.getElementById('groupImportPassword').value;
      const pwd2 = document.getElementById('groupImportPassword2').value;
      if (!isStrongUserGroupImportPwd(pwd)) { showToast(`默认密码强度不足：${USER_GROUP_IMPORT_PWD_RULE}`, 'error'); return; }
      if (pwd !== pwd2) { showToast('两次输入的密码不一致', 'error'); return; }

      const btn = document.getElementById('groupImportSubmitBtn');
      userGroupImportSubmitting = true;
      if (btn) { btn.disabled = true; btn.textContent = '导入中...'; }
      try {
        const res = await apiCall('POST', `/groups/${gid}/import`, { users, default_password: pwd });
        closeUserGroupImportModal();
        renderUserGroupImportResult(res);
        await loadUserGroups();
        if (currentUserGroupId === gid) loadUserGroupMembers();
      } catch (err) {
        // 契约 400：整单拒绝（空表/超限/未提供默认密码/密码强度不足），message 已是中文文案
        if (err && err.status === 400) {
          showToast(err.message || '导入参数不合法', 'error');
        } else if (err && err.status === 403) {
          const g = userGroupsCache.find(x => x.id === gid);
          showToast(isSystemUserGroup(g)
            ? '系统组不可导入（个人组与「所有用户」由系统维护）'
            : (err.message || '需超级管理员权限才能导入'), 'error');
        } else {
          showToast(err.message || '导入失败', 'error');
        }
      } finally {
        userGroupImportSubmitting = false;
        if (btn) btn.textContent = '开始导入';
        updateUserGroupImportStrength();
      }
    }

    loadAdminProblems();
    loadAllCategories();
    loadAllTags();
    initUserGroupImportTools();