      /* ─── Global Variables ─── */
      const API = window.location.origin;
      let supabaseClient = null;
      let currentUserSession = null;
      let isSignUpMode = false;

      let globalEvents   = [];
      let chartInstance   = null;
      let peopleChartInstance = null;
      let calendarInstance = null;
      let currentView     = 'home';

      const state = {
        people: [],
        currentPerson: '',
        search: '',
        filter: 'all',
        selectedHomeYear: null,
      };

      /* ═══════════════════════════
         AUTH & HELPER FETCH
         ═══════════════════════════ */
      async function initSupabaseAuth() {
        try {
          const configRes = await fetch(`${API}/api/config`);
          const config = await configRes.json();
          if (config.supabaseUrl && config.supabaseKey && window.supabase) {
            supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);

            // Check initial session FIRST, then set up listener
            // This prevents race condition where both getSession + onAuthStateChange fire loadApp()
            const { data } = await supabaseClient.auth.getSession();
            currentUserSession = data.session;

            if (currentUserSession) {
              closeModal('authModal');
              updateUserProfile();
              await loadApp();
            } else {
              openModal('authModal');
            }

            // Listen for subsequent auth state changes (login/logout)
            supabaseClient.auth.onAuthStateChange(async (event, session) => {
              // Skip INITIAL_SESSION event — already handled above
              if (event === 'INITIAL_SESSION') return;
              currentUserSession = session;
              if (session) {
                closeModal('authModal');
                updateUserProfile();
                await loadApp();
              } else {
                openModal('authModal');
                document.getElementById('user-profile-badge').classList.add('hidden');
              }
            });
          }
        } catch (e) {
          console.error("Auth init error:", e);
        }
      }

      async function authFetch(url, options = {}) {
        let token = currentUserSession ? currentUserSession.access_token : '';
        if (!token && supabaseClient) {
          const { data } = await supabaseClient.auth.getSession();
          if (data.session) {
            currentUserSession = data.session;
            token = currentUserSession.access_token;
          }
        }

        options.headers = {
          ...options.headers,
          'Authorization': `Bearer ${token}`
        };

        const response = await fetch(url, options);
        if (response.status === 401) {
          openModal('authModal');
        }
        return response;
      }

      function toggleAuthMode() {
        isSignUpMode = !isSignUpMode;
        document.getElementById('auth-title').textContent = isSignUpMode ? 'Create Account' : 'Welcome to Debt Tracker';
        document.getElementById('auth-subtitle').textContent = isSignUpMode ? 'Sign up for a new personal finance workspace.' : 'Sign in to access your personal finance workspace.';
        document.getElementById('auth-submit-btn').textContent = isSignUpMode ? 'Sign Up' : 'Sign In';
        document.getElementById('auth-toggle-text').textContent = isSignUpMode ? 'Already have an account?' : "Don't have an account?";
        document.getElementById('auth-toggle-btn').textContent = isSignUpMode ? 'Sign In' : 'Sign Up';
        document.getElementById('auth-error').classList.add('hidden');
        
        const nameGroup = document.getElementById('auth-name-group');
        if (isSignUpMode) {
          nameGroup.classList.remove('hidden');
          document.getElementById('auth-name').required = true;
        } else {
          nameGroup.classList.add('hidden');
          document.getElementById('auth-name').required = false;
        }
      }

      function updateUserProfile() {
        if (!currentUserSession || !currentUserSession.user) return;
        const email = currentUserSession.user.email;
        const fullName = currentUserSession.user.user_metadata?.full_name;
        const avatarUrl = currentUserSession.user.user_metadata?.avatar_url;
        
        if (email) {
          const badge = document.getElementById('user-profile-badge');
          const initial = document.getElementById('user-initial');
          const avatarImg = document.getElementById('user-avatar-img');
          const emailDisplay = document.getElementById('user-email-display');
          
          const displayName = fullName || email.split('@')[0];
          
          if (avatarUrl) {
            avatarImg.src = avatarUrl + '?t=' + new Date().getTime(); // Prevent caching
            avatarImg.classList.remove('hidden');
            initial.classList.add('hidden');
          } else {
            initial.textContent = displayName.charAt(0).toUpperCase();
            avatarImg.classList.add('hidden');
            initial.classList.remove('hidden');
          }
          
          emailDisplay.textContent = displayName;
          badge.classList.remove('hidden');
        }
      }

      async function uploadAvatar(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
          showToast('File quá lớn. Vui lòng chọn ảnh dưới 2MB.', 'error');
          return;
        }
        
        const user = currentUserSession?.user;
        if (!user) return;
        
        const loadingOverlay = document.getElementById('avatar-loading');
        loadingOverlay.classList.remove('hidden');
        
        try {
          // Dọn dẹp các file ảnh cũ trong thư mục của user này trước khi upload
          const { data: files } = await supabaseClient.storage
            .from('avatars')
            .list(user.id);

          if (files && files.length > 0) {
            const filesToDelete = files.map(f => `${user.id}/${f.name}`);
            await supabaseClient.storage.from('avatars').remove(filesToDelete);
          }

          const fileExt = file.name.split('.').pop();
          // Put the avatar in a folder named after the user ID to secure it with RLS policies easily
          const filePath = `${user.id}/avatar.${fileExt}`;
          
          const { data, error } = await supabaseClient.storage
            .from('avatars')
            .upload(filePath, file, { upsert: true });
            
          if (error) throw error;
          
          const { data: publicUrlData } = supabaseClient.storage
            .from('avatars')
            .getPublicUrl(filePath);
            
          const avatarUrl = publicUrlData.publicUrl;
          
          const { error: updateError } = await supabaseClient.auth.updateUser({
            data: { avatar_url: avatarUrl }
          });
          
          if (updateError) throw updateError;
          
          currentUserSession.user.user_metadata.avatar_url = avatarUrl;
          updateUserProfile();
          showToast('Cập nhật ảnh đại diện thành công!', 'success');
        } catch (error) {
          console.error('Lỗi upload avatar:', error);
          showToast('Không thể tải ảnh lên: ' + error.message, 'error');
        } finally {
          loadingOverlay.classList.add('hidden');
          event.target.value = '';
        }
      }

      const DEFAULT_COVER_URL = "https://images.unsplash.com/photo-1707343843437-caacff5cfa74?auto=format&fit=crop&w=2000&q=80";

      async function uploadCover(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          showToast('File quá lớn. Vui lòng chọn ảnh dưới 5MB.', 'error');
          return;
        }
        
        const user = currentUserSession?.user;
        if (!user || !state.currentPerson || state.currentPerson === 'All') return;
        
        const loadingOverlay = document.getElementById('cover-loading');
        if (loadingOverlay) loadingOverlay.classList.remove('hidden');
        
        try {
          const fileExt = file.name.split('.').pop();
          const safePersonName = encodeURIComponent(state.currentPerson);
          // Upload to avatars bucket but under covers/ prefix
          const filePath = `${user.id}/covers/${safePersonName}_${Date.now()}.${fileExt}`;
          
          const { data, error } = await supabaseClient.storage
            .from('avatars')
            .upload(filePath, file, { upsert: true });
            
          if (error) throw error;
          
          const { data: publicUrlData } = supabaseClient.storage
            .from('avatars')
            .getPublicUrl(filePath);
            
          const coverUrl = publicUrlData.publicUrl;
          
          // Upsert to person_profiles table
          const { error: dbError } = await supabaseClient
            .from('person_profiles')
            .upsert({
                user_id: user.id,
                person_name: state.currentPerson,
                cover_photo_url: coverUrl
            }, { onConflict: 'user_id, person_name' });

          if (dbError) throw dbError;
          
          // Update UI
          const coverImageDiv = document.getElementById('cover-image');
          if (coverImageDiv) {
              coverImageDiv.style.backgroundImage = `url('${coverUrl}')`;
          }
          showToast('Cập nhật ảnh bìa thành công!', 'success');
          closeModal('coverModal');
        } catch (error) {
          console.error('Lỗi upload cover:', error);
          showToast('Không thể tải ảnh lên: ' + error.message, 'error');
        } finally {
          if (loadingOverlay) loadingOverlay.classList.add('hidden');
          event.target.value = '';
        }
      }

      async function loadCoverPhoto(personName) {
        const coverImageDiv = document.getElementById('cover-image');
        const changeCoverBtn = document.getElementById('change-cover-btn');
        
        if (!coverImageDiv) return;

        if (!personName || personName === 'All') {
            coverImageDiv.style.backgroundImage = `url('${DEFAULT_COVER_URL}')`;
            if (changeCoverBtn) changeCoverBtn.classList.add('hidden');
            return;
        }

        if (changeCoverBtn) changeCoverBtn.classList.remove('hidden');

        try {
            const { data, error } = await supabaseClient
              .from('person_profiles')
              .select('cover_photo_url')
              .eq('person_name', personName)
              .single();
            
            if (data && data.cover_photo_url) {
                coverImageDiv.style.backgroundImage = `url('${data.cover_photo_url}')`;
            } else {
                coverImageDiv.style.backgroundImage = `url('${DEFAULT_COVER_URL}')`;
            }
        } catch (error) {
            console.error('Lỗi lấy ảnh bìa:', error);
            coverImageDiv.style.backgroundImage = `url('${DEFAULT_COVER_URL}')`;
        }
      }

      const GALLERY_COVERS = [
        "/libs/covers/lofi_plants_1785415358403.png",
        "/libs/covers/lofi_desk_1785415367955.png",
        "/libs/covers/lofi_city_1785415378301.png",
        "/libs/covers/lofi_nature_1785415387396.png"
      ];

      function renderCoverGallery() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;
        grid.innerHTML = '';
        GALLERY_COVERS.forEach(url => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'w-full h-24 rounded-xl overflow-hidden border-2 border-transparent hover:border-indigo-500 focus:outline-none focus:border-indigo-500 transition shadow-sm group relative';
            btn.innerHTML = `<img src="${url}" class="w-full h-full object-cover group-hover:scale-110 transition duration-300" />
                             <div class="absolute inset-0 bg-indigo-500/0 group-hover:bg-indigo-500/20 transition duration-300"></div>`;
            btn.onclick = () => selectGalleryCover(url);
            grid.appendChild(btn);
        });
      }

      async function selectGalleryCover(url) {
        const user = currentUserSession?.user;
        if (!user || !state.currentPerson || state.currentPerson === 'All') return;

        try {
            const { error: dbError } = await supabaseClient
            .from('person_profiles')
            .upsert({
                user_id: user.id,
                person_name: state.currentPerson,
                cover_photo_url: url
            }, { onConflict: 'user_id, person_name' });

            if (dbError) throw dbError;

            const coverImageDiv = document.getElementById('cover-image');
            if (coverImageDiv) {
                coverImageDiv.style.backgroundImage = `url('${url}')`;
            }
            showToast('Đã chọn ảnh bìa thành công!', 'success');
            closeModal('coverModal');
        } catch (error) {
            console.error('Lỗi chọn ảnh bìa:', error);
            showToast('Không thể cập nhật ảnh bìa: ' + error.message, 'error');
        }
      }

      async function handleAuthSubmit(e) {
        e.preventDefault();
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        const errEl = document.getElementById('auth-error');
        const submitBtn = document.getElementById('auth-submit-btn');

        errEl.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';

        try {
          if (!supabaseClient) throw new Error('Supabase client not initialized');

          let res;
          if (isSignUpMode) {
            const fullName = document.getElementById('auth-name').value.trim();
            res = await supabaseClient.auth.signUp({
              email,
              password,
              options: {
                data: {
                  full_name: fullName
                }
              }
            });
          } else {
            res = await supabaseClient.auth.signInWithPassword({ email, password });
          }

          if (res.error) throw res.error;

          if (isSignUpMode && !res.data.session) {
            showToast('Account created! Please check your email to confirm registration.', 'success');
            toggleAuthMode();
          } else if (res.data.session) {
            currentUserSession = res.data.session;
            closeModal('authModal');
            showToast('Signed in successfully!', 'success');
            await loadApp();
          }
        } catch (error) {
          errEl.textContent = error.message;
          errEl.classList.remove('hidden');
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = isSignUpMode ? 'Sign Up' : 'Sign In';
        }
      }

      async function handleLogout() {
        const confirmed = await customConfirm('Sign Out', 'Are you sure you want to sign out?', { confirmText: 'Sign Out' });
        if (confirmed) {
          if (supabaseClient) await supabaseClient.auth.signOut();
          currentUserSession = null;
          openModal('authModal');
          showToast('Signed out successfully.', 'success');
        }
      }

      /* ═══════════════════════════
         VIEW ROUTING
         ═══════════════════════════ */
      function switchView(viewId) {
        currentView = viewId;

        // Hide all views
        document.getElementById('view-home').classList.add('hidden');
        document.getElementById('view-analytics').classList.add('hidden');
        document.getElementById('view-calendar').classList.add('hidden');

        // Show target with fade animation
        const targetView = document.getElementById(`view-${viewId}`);
        targetView.classList.remove('hidden');
        targetView.classList.remove('view-fade');
        void targetView.offsetWidth; // force reflow
        targetView.classList.add('view-fade');

        // Update sidebar active state
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        const activeBtn = document.getElementById(`nav-${viewId}`);
        if (activeBtn) activeBtn.classList.add('active');

        // Update Header Title
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) {
          if (viewId === 'home') pageTitle.textContent = 'Debt Tracker';
          else if (viewId === 'analytics') pageTitle.textContent = 'Total';
          else if (viewId === 'calendar') pageTitle.textContent = 'Calendar';
        }

        // Toggle + New Person button visibility
        const newPersonBtn = document.getElementById('new-person-btn');
        if (newPersonBtn) {
          if (viewId === 'home') newPersonBtn.classList.remove('hidden');
          else newPersonBtn.classList.add('hidden');
        }

        // FullCalendar needs a re-render when its container becomes visible
        if (viewId === 'calendar') {
          setTimeout(() => {
            if (calendarInstance) calendarInstance.render();
          }, 100);
        }
      }

      /* ═══════════════════════════
         TOAST NOTIFICATION
         ═══════════════════════════ */
      function showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `show ${type}`;
        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(() => { toast.className = ''; }, 2800);
      }

      function applyTheme(theme) {
        const isDark = theme === 'dark';
        document.documentElement.classList.toggle('dark', isDark);
        document.body.classList.toggle('dark', isDark);
        const icon = document.getElementById('theme-toggle-icon');
        if (icon) {
          icon.innerHTML = isDark
            ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>'
            : '<path d="M12 3v2"/><path d="M12 19v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/><circle cx="12" cy="12" r="3.5"/>';
        }
        localStorage.setItem('debt-tracker-theme', theme);
      }

      function toggleTheme() {
        const nextTheme = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
        applyTheme(nextTheme);
        showToast(nextTheme === 'dark' ? 'Dark mode enabled.' : 'Light mode enabled.', 'success');
      }

      /* ═══════════════════════════
         FORMATTING HELPERS
         ═══════════════════════════ */
      function escapeHTML(str) {
        return String(str || '').replace(/[&<>'"]/g, tag => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag));
      }

      function fmt(value) {
        const num = Number(value || 0);
        const isNeg = num < 0;
        return (isNeg ? '-' : '') + '$' + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 0 });
      }

      function formatDate(value) {
        if (!value) return '—';
        return value;
      }

      function getEventTotal(event) {
        const items = event.event_items || [];
        return items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      }

      let sortConfig = { key: null, direction: 'asc' };

      function sortBy(key) {
        if (sortConfig.key === key) {
          sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
        } else {
          sortConfig.key = key;
          sortConfig.direction = 'asc';
        }
        renderTable();
      }

      function getFilteredEvents() {
        let events = globalEvents.filter(event => {
          const matchesFilter = state.filter === 'all' || event.pay_status === state.filter;
          const searchText = state.search.trim().toLowerCase();
          const matchesSearch = !searchText || event.title.toLowerCase().includes(searchText);
          
          let matchesYear = true;
          if (state.selectedHomeYear) {
             const year = event.event_date ? event.event_date.split('-')[0] : 'Unknown';
             matchesYear = (year === state.selectedHomeYear);
          }
          
          return matchesFilter && matchesSearch && matchesYear;
        });

        if (sortConfig.key) {
          events.sort((a, b) => {
            let valA, valB;
            if (sortConfig.key === 'id') { valA = a.id; valB = b.id; }
            if (sortConfig.key === 'date') { valA = a.event_date; valB = b.event_date; }
            if (sortConfig.key === 'title') { valA = a.title.toLowerCase(); valB = b.title.toLowerCase(); }
            if (sortConfig.key === 'amount') { valA = getEventTotal(a); valB = getEventTotal(b); }
            if (sortConfig.key === 'type') { valA = a.debt_type; valB = b.debt_type; }
            if (sortConfig.key === 'pay_date') { valA = a.actual_pay_date || a.pay_date || ''; valB = b.actual_pay_date || b.pay_date || ''; }
            if (sortConfig.key === 'status') { valA = a.pay_status; valB = b.pay_status; }
            if (sortConfig.key === 'method') { valA = a.payment_method || a.method || ''; valB = b.payment_method || b.method || ''; }

            if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
            if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
            return 0;
          });
        }
        return events;
      }

      /* ═══════════════════════════
         FILTER
         ═══════════════════════════ */
      function applyFilter(value) {
        state.filter = value;
        renderTable();
      }

      function applySearch(value) {
        state.search = value;
        renderTable();
      }

      /* ═══════════════════════════
         SKELETON LOADING
         ═══════════════════════════ */
      function renderSkeleton() {
        const tbody = document.getElementById('table-body');
        if (!tbody) return;
        tbody.innerHTML = Array.from({ length: 5 }, () => `
          <tr>
            <td class="px-4 py-4"><div class="skeleton h-4 w-8 rounded"></div></td>
            <td class="px-4 py-4"><div class="skeleton h-4 w-24 rounded"></div></td>
            <td class="px-4 py-4"><div class="skeleton h-4 w-40 rounded"></div></td>
            <td class="px-4 py-4 text-right"><div class="skeleton h-4 w-16 rounded ml-auto"></div></td>
            <td class="px-4 py-4"><div class="skeleton h-4 w-20 rounded"></div></td>
            <td class="px-4 py-4"><div class="skeleton h-4 w-20 rounded"></div></td>
            <td class="px-4 py-4"><div class="skeleton h-4 w-16 rounded"></div></td>
            <td class="px-4 py-4"><div class="skeleton h-4 w-16 rounded"></div></td>
          </tr>
        `).join('');
      }

      /* ═══════════════════════════
         RENDER HOME VIEW (Gallery or Table)
         ═══════════════════════════ */
      function renderHomeView() {
        const gallery = document.getElementById('home-year-gallery');
        const detail = document.getElementById('home-year-detail');
        const emptyMsg = document.getElementById('home-year-empty');
        if (!gallery || !detail) return;

        if (state.selectedHomeYear) {
           gallery.classList.add('hidden');
           emptyMsg.classList.add('hidden');
           detail.classList.remove('hidden');
           
           const titleEl = document.getElementById('detail-year-title');
           if (titleEl) titleEl.textContent = `Year ${state.selectedHomeYear}`;
           
           renderTable();
        } else {
           detail.classList.add('hidden');
           
           if (!globalEvents || globalEvents.length === 0) {
               gallery.classList.add('hidden');
               emptyMsg.classList.remove('hidden');
               return;
           }
           emptyMsg.classList.add('hidden');
           gallery.classList.remove('hidden');
           
           const summaries = {};
           globalEvents.forEach(e => {
               const year = e.event_date ? e.event_date.split('-')[0] : 'Unknown';
               if (!summaries[year]) summaries[year] = { count: 0, borrowed: 0, lent: 0, paid: 0 };
               summaries[year].count++;
               const total = getEventTotal(e);
               if (e.debt_type === 'lend') summaries[year].lent += total;
               else summaries[year].borrowed += total;
               
               if (e.pay_status === 'paid') summaries[year].paid++;
           });
           
           const sortedYears = Object.keys(summaries).sort((a,b) => b.localeCompare(a));
           gallery.innerHTML = sortedYears.map(year => {
               const s = summaries[year];
               const progress = s.count > 0 ? (s.paid / s.count) * 100 : 0;
               return `
                 <div class="cursor-pointer group relative bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all duration-300 overflow-hidden flex flex-col" onclick="openYear('${year}')">
                    <div class="h-12 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border-b border-slate-100 flex items-center px-5">
                       <span class="text-xs font-bold text-indigo-600 uppercase tracking-wider">Year ${year}</span>
                    </div>
                    <div class="p-5 flex-1 flex flex-col">
                       <h3 class="text-xl font-bold text-slate-800 mb-1">${year}</h3>
                       <p class="text-sm text-slate-500 mb-4">${s.count} Events</p>
                       
                       <div class="flex items-center gap-4 mb-4">
                          <div>
                            <p class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Borrowed</p>
                            <p class="text-sm font-bold text-rose-600">${fmt(s.borrowed)}</p>
                          </div>
                          <div>
                            <p class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Lent</p>
                            <p class="text-sm font-bold text-emerald-600">${fmt(s.lent)}</p>
                          </div>
                       </div>
                       
                       <div class="mt-auto">
                          <div class="flex justify-between text-xs mb-1.5">
                            <span class="text-slate-500 font-medium">Completion</span>
                            <span class="text-slate-700 font-bold">${Math.round(progress)}%</span>
                          </div>
                          <div class="w-full bg-slate-100 rounded-full h-1.5">
                            <div class="bg-indigo-500 h-1.5 rounded-full" style="width: ${progress}%"></div>
                          </div>
                       </div>
                    </div>
                 </div>
               `;
           }).join('');
        }
      }
      
      function openYear(year) {
         state.selectedHomeYear = year;
         state.filter = 'all';
         state.search = '';
         document.getElementById('filterSelect').value = 'all';
         document.getElementById('searchInput').value = '';
         renderHomeView();
      }
      
      function closeYear() {
         state.selectedHomeYear = null;
         renderHomeView();
      }

      /* ═══════════════════════════
         RENDER TABLE (Home View)
         ═══════════════════════════ */
      function renderTable() {
        const table = document.getElementById('events-table');
        if (!table) return;

        // Remove old tbodys
        table.querySelectorAll('tbody').forEach(tb => tb.remove());

        let events = getFilteredEvents();

        if (!events || events.length === 0) {
          const emptyTbody = document.createElement('tbody');
          emptyTbody.innerHTML = `
            <tr>
              <td colspan="9" class="empty-state">
                <div class="empty-state-icon">📋</div>
                <h3>No events yet</h3>
                <p>Start by clicking "+ Add Event" to track a new debt or payment.</p>
              </td>
            </tr>`;
          table.appendChild(emptyTbody);
          return;
        }

        // Apply custom sort order if any (only if manual sorting is not active)
        if (!sortConfig.key) {
          try {
            const sortOrder = JSON.parse(localStorage.getItem('eventSortOrder_' + state.currentPerson)) || [];
            if (sortOrder.length > 0) {
              events.sort((a, b) => {
                const idxA = sortOrder.indexOf(a.id);
                const idxB = sortOrder.indexOf(b.id);
                if (idxA === -1 && idxB === -1) return 0;
                if (idxA === -1) return 1;
                if (idxB === -1) return -1;
                return idxA - idxB;
              });
            }
          } catch(e) {}
        }

        events.forEach((event, index) => {
          const items = event.event_items || [];
          const eventTotal = getEventTotal(event);
          const isPaid = event.pay_status === 'paid';
          const isLend = event.debt_type === 'lend';
          const textClass = isPaid ? 'text-slate-400 line-through' : 'text-slate-700';
          const badgeClass = isPaid
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-amber-100 text-amber-700';

          const amountColor = isPaid
            ? 'text-slate-400 line-through'
            : (isLend ? 'text-emerald-600' : 'text-rose-600');
          const amountPrefix = isLend ? '+' : '-';

          const typeBadge = isLend
            ? '<span class="rounded-full px-2 py-0.5 text-xs font-semibold bg-emerald-50 text-emerald-700 whitespace-nowrap">They owe me</span>'
            : '<span class="rounded-full px-2 py-0.5 text-xs font-semibold bg-rose-50 text-rose-700 whitespace-nowrap">I owe them</span>';

          const parentRow = `
            <tr class="row-hover striped-row ${isPaid ? 'bg-slate-50' : 'bg-white'}" style="cursor: grab;">
              <td class="px-4 py-3 font-semibold text-slate-500">${index + 1}</td>
              <td class="px-4 py-3 whitespace-nowrap text-slate-500">${formatDate(event.event_date)}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <span class="h-2.5 w-2.5 rounded-full ${isPaid ? 'bg-emerald-400' : (isLend ? 'bg-emerald-500' : 'bg-rose-500')}"></span>
                  <span class="font-medium ${textClass}" title="${escapeHTML(event.title)}">${escapeHTML(event.title)}</span>
                </div>
              </td>
              <td class="px-4 py-3 text-right font-semibold ${amountColor}">${amountPrefix}${fmt(Math.abs(eventTotal))}</td>
              <td class="px-4 py-3">${typeBadge}</td>
              <td class="px-4 py-3 text-slate-500">${formatDate(event.pay_date || event.actual_pay_date)}</td>
              <td class="px-4 py-3">
                <span class="rounded-full px-2.5 py-1 text-xs font-semibold ${badgeClass}">
                  ${isPaid ? 'Paid' : 'Unpaid'}
                </span>
              </td>
              <td class="px-4 py-3 text-slate-500">${escapeHTML(event.method || event.payment_method || '—')}</td>
              <td class="px-4 py-3 text-center whitespace-nowrap action-col">
                <div class="flex items-center justify-end gap-3">
                  <button class="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition no-drag" onclick="openEditEventModal('${event.id}')" title="Edit Event">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                  </button>
                  <button class="p-1.5 rounded-lg border border-rose-100 dark:border-rose-900/50 text-rose-400 hover:text-white hover:bg-rose-500 hover:border-rose-500 transition no-drag" onclick="deleteEvent('${event.id}')" title="Delete Event">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                  </button>
                </div>
              </td>
            </tr>
          `;

          const childRows = items.map(item => `
            <tr class="row-hover ${isPaid ? 'bg-slate-50' : 'bg-white'}">
              <td colspan="2" class="border-none"></td>
              <td class="px-4 py-1.5 item-indent ${textClass}" title="${escapeHTML(item.description)}">${escapeHTML(item.description)}</td>
              <td class="px-4 py-1.5 text-right text-slate-600 ${isPaid ? 'line-through' : ''}">${fmt(item.amount)}</td>
              <td colspan="4"></td>
              <td class="px-4 py-1.5 text-center whitespace-nowrap action-col">
                <div class="flex items-center justify-end gap-3 pr-1">
                  <button class="p-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition no-drag" onclick="openEditItemModal('${item.id}', '${encodeURIComponent(item.description)}', ${item.amount})" title="Edit Detail">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                  </button>
                  <button class="p-1 rounded-md border border-rose-100 dark:border-rose-900/50 text-rose-400 hover:text-white hover:bg-rose-500 hover:border-rose-500 transition no-drag" onclick="deleteItem('${item.id}')" title="Delete Detail">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                  </button>
                </div>
              </td>
            </tr>
          `).join('');

          const tbody = document.createElement('tbody');
          tbody.className = 'event-group bg-white';
          tbody.setAttribute('data-event-id', event.id);
          tbody.innerHTML = parentRow + childRows;
          table.appendChild(tbody);
        });

        // ─── Summary Row ───
        let totalBorrowed = 0, totalLent = 0, unpaidCount = 0, paidCount = 0;
        events.forEach(event => {
          const total = getEventTotal(event);
          if (event.debt_type === 'lend') totalLent += total;
          else totalBorrowed += total;
          if (event.pay_status === 'paid') paidCount++;
          else unpaidCount++;
        });
        const summaryTbody = document.createElement('tbody');
        summaryTbody.innerHTML = `
          <tr class="summary-row">
            <td colspan="2" class="px-4 py-3">
              <span class="text-slate-500 text-xs font-semibold uppercase tracking-wider">Summary</span>
            </td>
            <td colspan="3" class="px-4 py-3 text-slate-700 whitespace-nowrap">
              ${events.length} event${events.length !== 1 ? 's' : ''}
              <span class="text-xs font-medium ml-2">
                <span class="text-amber-600">${unpaidCount} unpaid</span>
                ·
                <span class="text-emerald-600">${paidCount} paid</span>
              </span>
            </td>
            <td colspan="3" class="px-4 py-3 text-right whitespace-nowrap">
              <span class="text-rose-600">-${fmt(totalBorrowed)}</span>
              <span class="text-slate-300 mx-1">/</span>
              <span class="text-emerald-600">+${fmt(totalLent)}</span>
            </td>
            <td class="action-col border-none"></td>
          </tr>`;
        table.appendChild(summaryTbody);
        
        // Initialize Sortable — destroy previous instance first to avoid stacking
        if (window.Sortable) {
          if (table._sortableInstance) {
            table._sortableInstance.destroy();
          }
          table._sortableInstance = Sortable.create(table, {
            animation: 150,
            draggable: 'tbody.event-group',
            filter: '.no-drag',
            preventOnFilter: false,
            onEnd: function () {
              const newOrder = [];
              table.querySelectorAll('tbody.event-group').forEach(tb => {
                newOrder.push(tb.getAttribute('data-event-id'));
              });
              localStorage.setItem('eventSortOrder_' + state.currentPerson, JSON.stringify(newOrder));
              renderTable();
            }
          });
        }
      }

      /* ═══════════════════════════
         RENDER ANALYTICS
         ═══════════════════════════ */
      function renderAnalytics() {
        let totalBorrowed = 0;
        let totalLent = 0;

        globalEvents.forEach(event => {
          const total = getEventTotal(event);
          if (event.debt_type === 'lend') {
            totalLent += total;
          } else {
            totalBorrowed += total;
          }
        });

        const netBalance = totalLent - totalBorrowed;

        document.getElementById('stat-borrowed').textContent = fmt(totalBorrowed);
        document.getElementById('stat-lent').textContent = fmt(totalLent);

        // Net balance styling
        const statNetEl = document.getElementById('stat-net');
        const statNetNoteEl = document.getElementById('stat-net-note');

        if (netBalance > 0) {
          statNetEl.textContent = '+' + fmt(netBalance);
          statNetEl.className = 'text-2xl font-bold text-emerald-600 mt-1';
          statNetNoteEl.textContent = `They need to pay you: ${fmt(netBalance)}`;
          statNetNoteEl.className = 'text-xs text-emerald-600 mt-0.5 font-medium';
        } else if (netBalance < 0) {
          statNetEl.textContent = '-' + fmt(Math.abs(netBalance));
          statNetEl.className = 'text-2xl font-bold text-rose-600 mt-1';
          statNetNoteEl.textContent = `You need to pay them: ${fmt(Math.abs(netBalance))}`;
          statNetNoteEl.className = 'text-xs text-rose-600 mt-0.5 font-medium';
        } else {
          statNetEl.textContent = '$0';
          statNetEl.className = 'text-2xl font-bold text-slate-400 mt-1';
          statNetNoteEl.textContent = 'Fully settled';
          statNetNoteEl.className = 'text-xs text-slate-400 mt-0.5 font-medium';
        }

        // ─── Doughnut Chart ───
        const canvas = document.getElementById('debtChart');
        const emptyMsg = document.getElementById('chart-empty');

        // Destroy previous instance to prevent layering
        if (chartInstance) {
          chartInstance.destroy();
          chartInstance = null;
        }

        // Build per-event data
        const labels = [];
        const data = [];
        const bgColors = [];

        globalEvents.forEach(event => {
          const total = getEventTotal(event);
          if (total > 0) {
            labels.push(event.title);
            if (event.debt_type === 'lend') {
              data.push(total);
              bgColors.push('#10b981'); // emerald-500
            } else {
              data.push(-total);
              bgColors.push('#f43f5e'); // rose-500
            }
          }
        });

        if (data.length === 0) {
          canvas.style.display = 'none';
          emptyMsg.classList.remove('hidden');
          return;
        }

        canvas.style.display = 'block';
        emptyMsg.classList.add('hidden');

        chartInstance = new Chart(canvas, {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'Balance',
              data,
              backgroundColor: bgColors,
              borderRadius: 6,
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            indexAxis: 'y', // horizontal bar chart
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#1e293b',
                titleFont: { family: 'Inter', weight: '600' },
                bodyFont: { family: 'Inter' },
                padding: 12,
                cornerRadius: 10,
                callbacks: {
                  label: ctx => {
                    const val = ctx.raw;
                    const type = val > 0 ? 'They owe me' : 'I owe them';
                    return ` ${type}: ${fmt(Math.abs(val))}`;
                  },
                },
              },
            },
            scales: {
              x: {
                grid: { color: '#f1f5f9' },
                ticks: {
                  callback: (val) => fmt(Math.abs(val))
                }
              },
              y: {
                grid: { display: false }
              }
            }
          },
        });

        // ─── Comparison by Person Chart ───
        const peopleContainer = document.getElementById('peopleChartContainer');
        const peopleCanvas = document.getElementById('peopleChart');
        const peopleEmptyMsg = document.getElementById('people-chart-empty');

        // Only show if viewing "All"
        if (state.currentPerson && state.currentPerson !== 'All') {
          peopleContainer.style.display = 'none';
        } else {
          peopleContainer.style.display = 'block';

          if (peopleChartInstance) {
            peopleChartInstance.destroy();
            peopleChartInstance = null;
          }

          // Aggregate by person
          const personTotals = {};
          globalEvents.forEach(event => {
            const person = event.person;
            if (!personTotals[person]) {
              personTotals[person] = { borrow: 0, lend: 0 };
            }
            const total = getEventTotal(event);
            if (event.debt_type === 'lend') {
              personTotals[person].lend += total;
            } else {
              personTotals[person].borrow += total;
            }
          });

          const pLabels = Object.keys(personTotals);
          
          if (pLabels.length === 0) {
            peopleCanvas.style.display = 'none';
            peopleEmptyMsg.classList.remove('hidden');
          } else {
            peopleCanvas.style.display = 'block';
            peopleEmptyMsg.classList.add('hidden');

            const pBorrowData = pLabels.map(p => personTotals[p].borrow);
            const pLendData = pLabels.map(p => personTotals[p].lend);

            peopleChartInstance = new Chart(peopleCanvas, {
              type: 'bar',
              data: {
                labels: pLabels,
                datasets: [
                  {
                    label: 'I owe them',
                    data: pBorrowData,
                    backgroundColor: '#f43f5e',
                    borderRadius: 4
                  },
                  {
                    label: 'They owe me',
                    data: pLendData,
                    backgroundColor: '#10b981',
                    borderRadius: 4
                  }
                ]
              },
              options: {
                responsive: true,
                plugins: {
                  legend: { 
                    position: 'top',
                    labels: {
                      font: { family: 'Inter' }
                    }
                  },
                  tooltip: {
                    backgroundColor: '#1e293b',
                    titleFont: { family: 'Inter', weight: '600' },
                    bodyFont: { family: 'Inter' },
                    padding: 12,
                    cornerRadius: 10,
                    callbacks: {
                      label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}`
                    }
                  }
                },
                scales: {
                  x: { grid: { display: false } },
                  y: {
                    beginAtZero: true,
                    grid: { color: '#f1f5f9' },
                    ticks: { callback: val => fmt(val) }
                  }
                }
              }
            });
          }
        }
      }

      /* ═══════════════════════════
         UPDATE CALENDAR EVENTS
         ═══════════════════════════ */
      function updateCalendarEvents() {
        if (!calendarInstance) return;

        // Remove all existing events
        calendarInstance.removeAllEvents();

        // Map globalEvents to calendar events with color-coding
        globalEvents.forEach(event => {
          const total = getEventTotal(event);
          const isPaid = event.pay_status === 'paid';
          const isLend = event.debt_type === 'lend';
          const titlePrefix = state.currentPerson === 'All' && event.person ? `[${event.person}] ` : '';

          let bgColor, textColor;
          if (isPaid) {
            bgColor = '#d1fae5'; textColor = '#065f46';
          } else if (isLend) {
            bgColor = '#10b981'; textColor = '#ffffff';
          } else {
            bgColor = '#f43f5e'; textColor = '#ffffff';
          }

          calendarInstance.addEvent({
            id: event.id,
            title: `${titlePrefix}${event.title} (${fmt(total)})`,
            start: event.event_date,
            color: bgColor,
            textColor: textColor,
            extendedProps: {
              pay_status: event.pay_status,
              debt_type: event.debt_type,
              items: event.event_items
            }
          });
        });
        
        // Also update summary immediately
        if (calendarInstance.view) {
           const d = calendarInstance.view.currentStart;
           updateCalendarSummary(d.getFullYear(), d.getMonth());
        }
      }

      /* ═══════════════════════════
         FETCH DATA — Single source of truth
         ═══════════════════════════ */
      async function fetchData(personName) {
        const effectivePerson = personName || state.currentPerson || 'All';
        const cacheKey = `cached_events_${effectivePerson}`;
        
        // 1. Try to render from local cache first for instant load (SWR)
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          try {
            globalEvents = JSON.parse(cached);
            renderHomeView();
            renderAnalytics();
            updateCalendarEvents();
          } catch (e) {
            console.error('Failed to parse cached events:', e);
          }
        } else {
          renderSkeleton();
        }

        try {
          const url = effectivePerson === 'All' 
            ? `${API}/api/events` 
            : `${API}/api/events?person=${encodeURIComponent(effectivePerson)}`;
          const response = await authFetch(url);
          const json = await response.json();
          globalEvents = json.data || [];

          // 2. Cache the fresh data
          localStorage.setItem(cacheKey, JSON.stringify(globalEvents));

          // Sync all views with fresh data
          renderHomeView();
          renderAnalytics();
          updateCalendarEvents();
        } catch (error) {
          console.error(error);
          if (cached) {
            showToast('Offline/Cache mode: displaying local data.', 'error');
          } else {
            document.getElementById('table-body').innerHTML = `
              <tr>
                <td colspan="9" class="px-4 py-10 text-center text-sm text-rose-500">
                  Unable to connect to server: ${error.message}
                </td>
              </tr>`;
          }
        }
      }

      /* ═══════════════════════════
         MODALS
         ═══════════════════════════ */
      function openModal(modalId) {
        document.getElementById(modalId).classList.add('open');
      }

      function closeModal(modalId) {
        document.getElementById(modalId).classList.remove('open');
        if (modalId === 'confirmModal' && window._currentConfirmResolve) {
           window._currentConfirmResolve(false);
           window._currentConfirmResolve = null;
        }
      }

      function customConfirm(title, message, options = {}) {
        return new Promise((resolve) => {
          document.getElementById('modal-confirm-title').innerHTML = title;
          document.getElementById('modal-confirm-msg').innerHTML = message;
          
          const inputWrapper = document.getElementById('modal-confirm-input-wrapper');
          const inputEl = document.getElementById('modal-confirm-input');
          const labelEl = document.getElementById('modal-confirm-input-label');
          const errorEl = document.getElementById('modal-confirm-input-error');
          const confirmBtn = document.getElementById('modal-confirm-btn');
          
          if (options.requireInput) {
            inputWrapper.classList.remove('hidden');
            labelEl.textContent = options.inputLabel || `Type "${options.requireInput}" to confirm:`;
            inputEl.value = '';
            errorEl.textContent = '';
            setTimeout(() => inputEl.focus(), 100);
            
            inputEl.onkeydown = (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                confirmBtn.click();
              }
            };
            inputEl.oninput = () => {
              errorEl.textContent = '';
              inputEl.classList.remove('border-rose-500');
            };
          } else {
            inputWrapper.classList.add('hidden');
            inputEl.onkeydown = null;
            inputEl.oninput = null;
            setTimeout(() => confirmBtn.focus(), 100);
          }

          if (options.isDanger) {
             confirmBtn.className = "rounded-xl bg-rose-600 px-6 py-2 text-sm font-semibold text-white hover:bg-rose-700 transition shadow-sm";
          } else {
             confirmBtn.className = "rounded-xl bg-indigo-600 px-6 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition shadow-sm";
          }
          confirmBtn.textContent = options.confirmText || 'Confirm';

          window._currentConfirmResolve = resolve;

          confirmBtn.onclick = () => {
             if (options.requireInput) {
               if (inputEl.value.trim() !== options.requireInput) {
                  errorEl.textContent = "Text does not match.";
                  inputEl.classList.add('border-rose-500');
                  return;
               }
             }
             window._currentConfirmResolve = null;
             closeModal('confirmModal');
             resolve(true);
          };
          
          openModal('confirmModal');
        });
      }

      function customPrompt(title, message, options = {}) {
        return new Promise((resolve) => {
          document.getElementById('modal-confirm-title').innerHTML = title;
          document.getElementById('modal-confirm-msg').innerHTML = message;
          
          const inputWrapper = document.getElementById('modal-confirm-input-wrapper');
          const inputEl = document.getElementById('modal-confirm-input');
          const labelEl = document.getElementById('modal-confirm-input-label');
          const errorEl = document.getElementById('modal-confirm-input-error');
          const confirmBtn = document.getElementById('modal-confirm-btn');
          
          inputWrapper.classList.remove('hidden');
          labelEl.textContent = options.inputLabel || "";
          inputEl.value = options.defaultValue || '';
          errorEl.textContent = '';
          inputEl.classList.remove('border-rose-500');
          setTimeout(() => inputEl.focus(), 100);

          inputEl.onkeydown = (e) => {
             if (e.key === 'Enter') {
                e.preventDefault();
                confirmBtn.click();
             }
          };
          inputEl.oninput = () => {
             errorEl.textContent = '';
             inputEl.classList.remove('border-rose-500');
          };

          confirmBtn.className = "rounded-xl bg-indigo-600 px-6 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition shadow-sm";
          confirmBtn.textContent = options.confirmText || 'OK';

          window._currentConfirmResolve = (val) => {
             resolve(null);
          };

          confirmBtn.onclick = () => {
             const val = inputEl.value.trim();
             if (options.required && !val) {
                errorEl.textContent = "This field is required.";
                inputEl.classList.add('border-rose-500');
                return;
             }
             window._currentConfirmResolve = null;
             closeModal('confirmModal');
             resolve(val);
          };
          
          openModal('confirmModal');
        });
      }

      
      function openPrintModal() {
        openModal('printModal');
      }

      function executePrint() {
        const format = document.querySelector('input[name="print_format"]:checked').value;
        closeModal('printModal');
        
        // Apply the chosen format class to the body
        document.body.classList.add(format);
        
        // Short delay to allow browser to apply CSS before printing
        setTimeout(() => {
          window.print();
          // Remove the class after printing
          document.body.classList.remove(format);
        }, 100);
      }

      function openEventModal() {
        document.getElementById('modal-event-header-title').textContent = 'Add Event';
        document.getElementById('modal-event-header-desc').textContent = 'Create a new debt or payment event.';
        document.getElementById('event-form').reset();
        const customInput = document.getElementById('modal-event-custom-method');
        if (customInput) customInput.classList.add('hidden');
        clearFieldErrors('event-form');
        document.getElementById('modal-event-id').value = '';
        document.getElementById('modal-event-status').value = 'unpaid';
        togglePayDate();
        openModal('eventModal');
      }

      function openDetailModal() {
        document.getElementById('modal-item-header-title').textContent = 'Add Detail';
        document.getElementById('modal-item-header-desc').textContent = 'Attach a detail item to an existing event.';
        document.getElementById('detail-form').reset();
        clearFieldErrors('detail-form');
        document.getElementById('modal-item-id').value = '';
        
        populateYearFilter();
        populateDetailEvents();
        
        openModal('detailModal');
      }

      function populateYearFilter() {
        const select = document.getElementById('modal-detail-year-filter');
        if (!select) return;
        
        const years = new Set();
        globalEvents.forEach(event => {
            if (event.event_date) {
                const year = event.event_date.split('-')[0];
                if (year) years.add(year);
            }
        });
        
        const sortedYears = Array.from(years).sort((a, b) => b - a);
        
        select.innerHTML = '<option value="all">All Years</option>';
        sortedYears.forEach(year => {
            const option = document.createElement('option');
            option.value = year;
            option.textContent = year;
            select.appendChild(option);
        });

        const currentYear = new Date().getFullYear().toString();
        if (sortedYears.includes(currentYear)) {
            select.value = currentYear;
        } else {
            select.value = 'all';
        }
      }

      /* ═══════════════════════════
         SUBMIT EVENT
         ═══════════════════════════ */
      function clearFieldErrors(formId) {
        const form = document.getElementById(formId);
        if (!form) return;
        form.querySelectorAll('.form-error').forEach(el => el.textContent = '');
        form.querySelectorAll('.form-input').forEach(el => el.classList.remove('error'));
      }

      function validateEventForm() {
        const title = document.getElementById('modal-event-title').value.trim();
        const date = document.getElementById('modal-event-date').value;
        const titleInput = document.getElementById('modal-event-title');
        const dateInput = document.getElementById('modal-event-date');
        const titleError = document.getElementById('event-title-error');
        const dateError = document.getElementById('event-date-error');

        clearFieldErrors('event-form');
        let valid = true;

        if (!title) {
          titleInput.classList.add('error');
          titleError.textContent = 'Title is required.';
          valid = false;
        }

        if (!date) {
          dateInput.classList.add('error');
          dateError.textContent = 'Date is required.';
          valid = false;
        }

        if (!state.currentPerson) {
          showToast('Please select a person before creating an event.', 'error');
          valid = false;
        }

        return valid;
      }

      function validateDetailForm() {
        const description = document.getElementById('modal-detail-desc').value.trim();
        const amount = document.getElementById('modal-detail-amount').value;
        const descInput = document.getElementById('modal-detail-desc');
        const amountInput = document.getElementById('modal-detail-amount');
        const descError = document.getElementById('detail-desc-error');
        const amountError = document.getElementById('detail-amount-error');

        clearFieldErrors('detail-form');
        let valid = true;

        if (!description) {
          descInput.classList.add('error');
          descError.textContent = 'Description is required.';
          valid = false;
        }

        if (!amount || isNaN(amount)) {
          amountInput.classList.add('error');
          amountError.textContent = 'Vui lòng nhập số tiền hợp lệ.';
          valid = false;
        }

        return valid;
      }

      function togglePayDate() {
        const status = document.getElementById('modal-event-status').value;
        const wrapper = document.getElementById('modal-event-pay-date-wrapper');
        if (status === 'paid') wrapper.classList.remove('hidden');
        else wrapper.classList.add('hidden');
      }

      function toggleCustomMethod() {
        const methodSelect = document.getElementById('modal-event-method');
        const customInput = document.getElementById('modal-event-custom-method');
        if (methodSelect.value === 'Custom') {
          customInput.classList.remove('hidden');
          customInput.focus();
        } else {
          customInput.classList.add('hidden');
        }
      }

      async function submitEvent() {
        if (!validateEventForm()) return;

        const saveBtn = document.getElementById('event-save-btn');
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>Saving...`;
        }

        const title  = document.getElementById('modal-event-title').value.trim();
        const date   = document.getElementById('modal-event-date').value;
        const payStatus = document.getElementById('modal-event-status').value;
        const actualPayDate = document.getElementById('modal-event-pay-date').value || null;
        let method = document.getElementById('modal-event-method').value;
        if (method === 'Custom') {
            method = document.getElementById('modal-event-custom-method').value.trim() || 'Card';
        }
        const debtType = document.querySelector('input[name="debt_type"]:checked')?.value || 'borrow';

        try {
          const eventId = document.getElementById('modal-event-id').value;
          const url = eventId ? `${API}/api/events/${eventId}` : `${API}/api/events`;
          const methodType = eventId ? 'PUT' : 'POST';

          const response = await authFetch(url, {
            method: methodType,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              event_date: date,
              payment_method: method || 'None',
              person: state.currentPerson,
              debt_type: debtType,
              pay_status: payStatus,
              actual_pay_date: payStatus === 'paid' ? actualPayDate : null,
            }),
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error(errText);
            alert('Error creating event: ' + errText);
            return;
          }

          closeModal('eventModal');
          document.getElementById('event-form').reset();
          showToast('Event saved successfully.', 'success');
          await fetchData(state.currentPerson);
          populateDetailEvents();
        } catch (error) {
          console.error(error);
          alert('Failed to create event. ' + error.message);
        } finally {
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Save';
          }
        }
      }

      /* ═══════════════════════════
         SUBMIT DETAIL
         ═══════════════════════════ */
      async function submitDetail() {
        if (!validateDetailForm()) return;

        const eventId     = document.getElementById('modal-detail-event-id').value;
        const description = document.getElementById('modal-detail-desc').value.trim();
        const amount      = document.getElementById('modal-detail-amount').value;

        if (!eventId) {
          showToast('Please select an event before saving the detail.', 'error');
          return;
        }

        const saveBtn = document.getElementById('detail-save-btn');
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>Saving...`;
        }

        try {
          const itemId = document.getElementById('modal-item-id').value;
          const url = itemId ? `${API}/api/items/${itemId}` : `${API}/api/items`;
          const methodType = itemId ? 'PUT' : 'POST';

          const response = await authFetch(url, {
            method: methodType,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_id: eventId, description, amount: parseFloat(amount) }),
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error(errText);
            alert('Error adding detail: ' + errText);
            return;
          }

          closeModal('detailModal');
          document.getElementById('detail-form').reset();
          showToast('Detail saved successfully.', 'success');
          await fetchData(state.currentPerson);
        } catch (error) {
          console.error(error);
          alert('Failed to add detail. ' + error.message);
        } finally {
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Save';
          }
        }
      }

      /* ═══════════════════════════
         TOGGLE STATUS
         ═══════════════════════════ */
      async function toggleStatus(eventId) {
        try {
          // Lấy ngày hiện tại theo MÚI GIỜ CỦA TRÌNH DUYỆT người dùng
          // (không dùng server date để tránh sai lệch giữa VN/US/...)
          const now = new Date();
          const localDate = now.getFullYear() + '-'
            + String(now.getMonth() + 1).padStart(2, '0') + '-'
            + String(now.getDate()).padStart(2, '0');

          const response = await authFetch(`${API}/api/events/${eventId}/toggle-status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_date: localDate }),
          });
          if (!response.ok) throw new Error(await response.text());
          const json = await response.json();
          const status = json.data?.pay_status || 'unpaid';
          showToast(status === 'paid' ? 'Marked as paid.' : 'Marked as unpaid.', 'success');
          await fetchData(state.currentPerson);
        } catch (error) {
          showToast('Failed to update status. ' + error.message, 'error');
        }
      }

      /* ═══════════════════════════
         POPULATE DETAIL EVENT SELECT
         ═══════════════════════════ */
      function populateDetailEvents() {
        const select = document.getElementById('modal-detail-event-id');
        const yearFilter = document.getElementById('modal-detail-year-filter');
        if (!select) return;
        
        select.innerHTML = '<option value="">Select an event</option>';
        
        const selectedYear = yearFilter ? yearFilter.value : 'all';

        globalEvents.forEach(event => {
          let eventYear = null;
          if (event.event_date) {
             eventYear = event.event_date.split('-')[0];
          }

          if (selectedYear === 'all' || eventYear === selectedYear) {
             const option = document.createElement('option');
             option.value = event.id;
             const dateStr = event.event_date ? ` (${event.event_date})` : '';
             option.textContent = event.title + dateStr;
             select.appendChild(option);
          }
        });
      }

      /* ═══════════════════════════
         PEOPLE TABS
         ═══════════════════════════ */
      async function loadPeople() {
        // Try to load from cache first
        const cached = localStorage.getItem('cached_people');
        if (cached) {
          try {
            state.people = JSON.parse(cached);
            if (!state.currentPerson && state.people.length > 0) state.currentPerson = state.people[0];
            else if (!state.people.length) state.currentPerson = 'All';
            renderPeopleTabs();
          } catch (e) {
            console.error('Failed to parse cached people:', e);
          }
        }

        try {
          const response = await authFetch(`${API}/api/people`);
          const json = await response.json();
          state.people = json.data || [];
          if (!state.people.length) state.people = [];
          
          // Cache the fresh people list
          localStorage.setItem('cached_people', JSON.stringify(state.people));
          
          if (!state.currentPerson && state.people.length > 0) state.currentPerson = state.people[0];
          else if (!state.people.length) state.currentPerson = 'All';
          renderPeopleTabs();
          return state.people;
        } catch (error) {
          console.error('Failed to load people:', error);
          if (!cached) {
            state.people = [];
            state.currentPerson = 'All';
            renderPeopleTabs();
          }
          return state.people;
        }
      }

      function renderPeopleTabs() {
        const container = document.getElementById('people-tabs');
        if (!container) return;
        container.innerHTML = '';
        
        // Load custom sort order from localStorage
        let sortOrder = [];
        try {
          sortOrder = JSON.parse(localStorage.getItem('peopleSortOrder')) || [];
        } catch(e) {}
        
        // Sort state.people based on sortOrder
        let sortedPeople = [...state.people];
        sortedPeople.sort((a, b) => {
          let indexA = sortOrder.indexOf(a);
          let indexB = sortOrder.indexOf(b);
          if (indexA === -1 && indexB === -1) return a.localeCompare(b);
          if (indexA === -1) return 1;
          if (indexB === -1) return -1;
          return indexA - indexB;
        });

        // Add 'All' tab
        const allIsActive = state.currentPerson === 'All';
        const allTab = document.createElement('div');
        allTab.className = `person-tab ${allIsActive ? 'active' : ''}`;
        allTab.setAttribute('data-person', 'All');
        
        const allNameBtn = document.createElement('button');
        allNameBtn.type = 'button';
        allNameBtn.textContent = 'All';
        allNameBtn.className = 'person-name px-2';
        allNameBtn.onclick = async () => {
          state.selectedHomeYear = null;
          state.currentPerson = 'All';
          document.getElementById('header-subtitle').textContent = `To: All`;
          updatePrintHeader();
          renderPeopleTabs();
          await fetchData('All');
          loadCoverPhoto('All');
        };
        allTab.appendChild(allNameBtn);
        container.appendChild(allTab);

        sortedPeople.forEach(person => {
          const isActive = state.currentPerson === person;
          const tab = document.createElement('div');
          tab.className = `person-tab ${isActive ? 'active' : ''}`;
          tab.setAttribute('data-person', person);
          
          const nameBtn = document.createElement('button');
          nameBtn.type = 'button';
          nameBtn.textContent = person;
          nameBtn.className = 'person-name';
          nameBtn.onclick = async () => {
            state.selectedHomeYear = null;
            state.currentPerson = person;
            document.getElementById('header-subtitle').textContent = `To: ${person}`;
            updatePrintHeader();
            renderPeopleTabs();
            await fetchData(person);
            loadCoverPhoto(person);
          };

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.innerHTML = '&times;';
          delBtn.className = 'person-delete';
          delBtn.title = `Delete ${person}`;
              delBtn.onclick = async (e) => {
            e.stopPropagation();
            const confirmed = await customConfirm(
              'Delete Person',
              `<div class="space-y-2 text-slate-600 dark:text-slate-300">
                <p class="font-semibold text-rose-500">WARNING: Are you sure you want to delete "${escapeHTML(person)}"?</p>
                <p>This will <span class="font-semibold text-rose-600">PERMANENTLY</span> delete all events and debt history for this person!</p>
              </div>`,
              {
                isDanger: true,
                confirmText: 'Delete Permanently'
              }
            );
            if (!confirmed) return;
            try {
              const response = await authFetch(`${API}/api/people/${encodeURIComponent(person)}`, { method: 'DELETE' });
              const json = await response.json();
              if (!response.ok) throw new Error(json.detail || 'Failed to delete person');

              state.people = state.people.filter(p => p !== person);
              if (state.currentPerson === person) {
                state.currentPerson = state.people[0] || '';
              }
              renderPeopleTabs();
              if (state.currentPerson) {
                document.getElementById('header-subtitle').textContent = `To: ${state.currentPerson}`;
                updatePrintHeader();
                await fetchData(state.currentPerson);
              }
              showToast(`Deleted person: ${person}`, 'success');
            } catch (error) {
              showToast('Failed to delete person. ' + error.message, 'error');
            }
          };

          tab.appendChild(nameBtn);
          tab.appendChild(delBtn);
          container.appendChild(tab);
        });
        
        // Initialize SortableJS
        if (window.Sortable) {
          Sortable.create(container, {
            animation: 150,
            ghostClass: 'opacity-50',
            onEnd: function (evt) {
              // Save new order
              const newOrder = [];
              container.querySelectorAll('.person-tab').forEach(el => {
                newOrder.push(el.getAttribute('data-person'));
              });
              localStorage.setItem('peopleSortOrder', JSON.stringify(newOrder));
            }
          });
        }
      }

      function addPerson() {
        return addNewPerson();
      }

      async function addNewPerson() {
        const name = await customPrompt(
          'Add New Person',
          'Create a new profile to track events and debt history.',
          {
            inputLabel: 'Name of the person:',
            confirmText: 'Add Person',
            required: true
          }
        );
        if (!name) return;
        const trimmedName = name.trim();
        if (!trimmedName) return;

        try {
          const response = await authFetch(`${API}/api/people`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmedName }),
          });
          const json = await response.json();
          if (!response.ok) throw new Error(json.detail || 'Failed to save person');

          if (!state.people.includes(trimmedName)) {
            state.people.push(trimmedName);
          }
          state.currentPerson = trimmedName;
          renderPeopleTabs();
          document.getElementById('header-subtitle').textContent = `To: ${trimmedName}`;
          updatePrintHeader();
          await fetchData(trimmedName);
          showToast(`Saved person: ${trimmedName}`, 'success');
        } catch (error) {
          showToast('Failed to save person. ' + error.message, 'error');
        }
      }


      /* ═══════════════════════════
         INIT — DOMContentLoaded
         ═══════════════════════════ */
      document.addEventListener('DOMContentLoaded', async () => {
        const savedTheme = localStorage.getItem('debt-tracker-theme') || 'light';
        applyTheme(savedTheme);
        renderCoverGallery();

        // Initialize FullCalendar ONCE
        const calendarEl = document.getElementById('calendar-container');
        calendarInstance = new FullCalendar.Calendar(calendarEl, {
          initialView: 'dayGridMonth',
          headerToolbar: {
            left: 'today',
            center: 'title',
            right: 'dayGridMonth,dayGridWeek',
          },
          height: '100%',
          dayMaxEvents: 3,
          eventDisplay: 'block',
          eventClick: function(info) {
            openEditEventModal(info.event.id);
          },
          eventDidMount: function(info) {
            // Add a simple tooltip using title attribute
            const isPaid = info.event.extendedProps.pay_status === 'paid';
            const status = isPaid ? 'Paid' : 'Unpaid';
            info.el.title = `${info.event.title}\nStatus: ${status}\nItems: ${info.event.extendedProps.items ? info.event.extendedProps.items.length : 0}`;
          },
          datesSet: function(info) {
            const d = info.view.currentStart;
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const elLabel = document.getElementById('month-picker-label');
            if (elLabel) elLabel.textContent = `${months[d.getMonth()]} ${d.getFullYear()}`;
            if (typeof pickerCurrentYear !== 'undefined') pickerCurrentYear = d.getFullYear();
            updateCalendarSummary(d.getFullYear(), d.getMonth());
          }
        });
        // Render calendar (it's hidden, but we init the instance)
        calendarInstance.render();

        // Init Auth (will call loadApp if session exists)
        await initSupabaseAuth();
      });

      async function loadApp() {
        await loadPeople();
        document.getElementById('header-subtitle').textContent = `To: ${state.currentPerson}`;
        updatePrintHeader();
        renderPeopleTabs();
        await fetchData(state.currentPerson);
        loadCoverPhoto(state.currentPerson);
        
        // Check admin status on load
        try {
          const res = await authFetch(`${API}/api/admin/check`);
          if (res.ok) {
            document.getElementById('nav-admin').classList.remove('hidden');
          } else {
            document.getElementById('nav-admin').classList.add('hidden');
          }
        } catch (e) { }
      }

      // Record a visit as soon as the script parses
      fetch(`${API}/api/visits`, { method: 'POST' }).catch(()=>console.log('Visit tracked'));

      /* ═══════════════════════════
         ADMIN DASHBOARD LOGIC
         ═══════════════════════════ */
      async function openAdminModal() {
        openModal('adminModal');
        await loadAdminStats();
        await loadAdminList();
        await loadAllUsersList();
      }

      async function loadAdminStats() {
        try {
          const res = await authFetch(`${API}/api/admin/stats`);
          if (!res.ok) throw new Error('Failed to load stats');
          const json = await res.json();
          document.getElementById('admin-stat-visits').textContent = json.data.visits;
          document.getElementById('admin-stat-users').textContent = json.data.users;
        } catch(e) {
          console.error(e);
          document.getElementById('admin-stat-visits').textContent = 'Error';
          document.getElementById('admin-stat-users').textContent = 'Error';
        }
      }

      async function loadAdminList() {
        const tbody = document.getElementById('admin-users-list');
        tbody.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-slate-400">Loading...</td></tr>';
        try {
          const res = await authFetch(`${API}/api/admin/list`);
          if (!res.ok) throw new Error('Failed to load admin list');
          const json = await res.json();
          
          if (!json.data || json.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-slate-400">No admins found</td></tr>';
            return;
          }
          
          tbody.innerHTML = json.data.map(email => `
            <tr class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
              <td class="px-4 py-3 font-medium text-slate-700">${email}</td>
              <td class="px-4 py-3 text-right">
                <button type="button" class="text-rose-500 hover:text-rose-700 text-xs font-semibold px-2 py-1 rounded bg-rose-50 hover:bg-rose-100 transition" onclick="removeAdmin('${email}')">Remove</button>
              </td>
            </tr>
          `).join('');
        } catch(e) {
          console.error(e);
          tbody.innerHTML = `<tr><td colspan="2" class="p-4 text-center text-rose-500">${e.message}</td></tr>`;
        }
      }

      async function loadAllUsersList() {
        const tbody = document.getElementById('all-users-list');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-slate-400">Loading...</td></tr>';
        try {
          const res = await authFetch(`${API}/api/admin/all_users`);
          if (!res.ok) throw new Error('Failed to load users');
          const json = await res.json();
          
          if (!json.data || json.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-slate-400">No users found</td></tr>';
            return;
          }
          
          tbody.innerHTML = json.data.map(user => `
            <tr class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
              <td class="px-4 py-3 font-medium text-slate-700">
                <div>${escapeHTML(user.full_name || 'No Name')}</div>
                <div class="text-xs text-slate-400 font-normal">${escapeHTML(user.email)}</div>
              </td>
              <td class="px-4 py-3 text-right">
                <button type="button" class="text-indigo-600 hover:text-indigo-800 text-xs font-semibold px-3 py-1.5 rounded bg-indigo-50 hover:bg-indigo-100 transition" onclick="quickMakeAdmin('${escapeHTML(user.email)}')">Make Admin</button>
              </td>
            </tr>
          `).join('');
        } catch(e) {
          console.error(e);
          tbody.innerHTML = `<tr><td colspan="2" class="p-4 text-center text-rose-500">Could not load users list. Check if profiles table exists.</td></tr>`;
        }
      }

      function quickMakeAdmin(email) {
        document.getElementById('admin-new-email').value = email;
        submitAddAdmin({ preventDefault: () => {} });
      }

      async function submitAddAdmin(e) {
        e.preventDefault();
        const emailInput = document.getElementById('admin-new-email');
        const email = emailInput.value.trim();
        if (!email) return;

        try {
          const res = await authFetch(`${API}/api/admin/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
          });
          
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to add admin');
          }
          
          showToast(`Admin ${email} added successfully`, 'success');
          emailInput.value = '';
          await loadAdminList();
        } catch (e) {
          showToast(e.message, 'error');
        }
      }

      async function removeAdmin(email) {
        const confirmed = await customConfirm('Remove Admin', `Are you sure you want to remove admin rights for <b>${escapeHTML(email)}</b>?`, { isDanger: true, confirmText: 'Remove' });
        if (!confirmed) return;
        try {
          const res = await authFetch(`${API}/api/admin/remove/${encodeURIComponent(email)}`, {
            method: 'DELETE'
          });
          
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to remove admin');
          }
          
          showToast(`Admin ${email} removed`, 'success');
          await loadAdminList();
        } catch (e) {
          showToast(e.message, 'error');
        }
      }

      /* ═══════════════════════════
         PRINT HEADER SYNC
         ═══════════════════════════ */
      function updatePrintHeader() {
          const personEls = document.querySelectorAll('.print-person-name');
          const dateEl   = document.getElementById('print-date');
          const footerEl = document.getElementById('print-footer-date');
          const today = new Date().toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
          });
          personEls.forEach(el => {
            if (el.tagName === 'H2') el.textContent = `To: ${state.currentPerson || '—'}`;
            else el.textContent = state.currentPerson ? ' — ' + state.currentPerson : '';
          });
          if (dateEl)   dateEl.textContent = today;
          if (footerEl) footerEl.textContent = today;
        }

      function openEditEventModal(eventId) {
        document.getElementById('modal-event-header-title').textContent = 'Edit Event';
        document.getElementById('modal-event-header-desc').textContent = 'Modify an existing debt or payment event.';
        const event = globalEvents.find(e => e.id === eventId);
        if(!event) return;
        document.getElementById('event-form').reset();
        document.getElementById('modal-event-id').value = eventId;
        document.getElementById('modal-event-title').value = event.title;
        document.getElementById('modal-event-date').value = event.event_date;
        
        const methodSelect = document.getElementById('modal-event-method');
        const customInput = document.getElementById('modal-event-custom-method');
        const standardMethods = ['Card', 'Cash', 'Transfer'];
        
        if (event.payment_method && !standardMethods.includes(event.payment_method) && event.payment_method !== 'None') {
            methodSelect.value = 'Custom';
            customInput.value = event.payment_method;
            customInput.classList.remove('hidden');
        } else {
            methodSelect.value = event.payment_method === 'None' || !event.payment_method ? 'Card' : event.payment_method;
            customInput.value = '';
            customInput.classList.add('hidden');
        }

        if(event.debt_type === 'lend') {
            document.querySelector('input[name="debt_type"][value="lend"]').checked = true;
        } else {
            document.querySelector('input[name="debt_type"][value="borrow"]').checked = true;
        }
        document.getElementById('modal-event-status').value = event.pay_status || 'unpaid';
        document.getElementById('modal-event-pay-date').value = event.actual_pay_date || '';
        togglePayDate();
        openModal('eventModal');
      }

      function openEditItemModal(itemId, encodedDesc, amount) {
        document.getElementById('modal-item-header-title').textContent = 'Edit Detail';
        document.getElementById('modal-item-header-desc').textContent = 'Modify an existing detail item.';
        const desc = decodeURIComponent(encodedDesc);
        populateDetailEvents();
        document.getElementById('detail-form').reset();
        document.getElementById('modal-item-id').value = itemId;
        document.getElementById('modal-detail-desc').value = desc;
        document.getElementById('modal-detail-amount').value = amount;
        
        const event = globalEvents.find(e => e.event_items && e.event_items.some(i => i.id === itemId));
        if(event) {
            document.getElementById('modal-detail-event-id').value = event.id;
        }
        openModal('detailModal');
      }

      async function deleteEvent(eventId) {
        const confirmed = await customConfirm('Delete Event', 'Are you sure you want to delete this event? All details will be deleted as well.', { isDanger: true, confirmText: 'Delete' });
        if(!confirmed) return;
        try {
          const res = await authFetch(`${API}/api/events/${eventId}`, { method: 'DELETE' });
          if(!res.ok) throw new Error(await res.text());
          showToast('Event deleted.', 'success');
          await fetchData(state.currentPerson);
        } catch(e) { alert('Failed: ' + e.message); }
      }

      async function deleteItem(itemId) {
        const confirmed = await customConfirm('Delete Detail', 'Are you sure you want to delete this detail?', { isDanger: true, confirmText: 'Delete' });
        if(!confirmed) return;
        try {
          const res = await authFetch(`${API}/api/items/${itemId}`, { method: 'DELETE' });
          if(!res.ok) throw new Error(await res.text());
          showToast('Detail deleted.', 'success');
          await fetchData(state.currentPerson);
        } catch(e) { alert('Failed: ' + e.message); }
      }

      function goToCalendarMonth(val) {
        if (!val || !calendarInstance) return;
        calendarInstance.gotoDate(val + '-01');
      }

      function updateCalendarSummary(year, month) {
        let borrowed = 0;
        let lent = 0;
        
        globalEvents.forEach(event => {
          if (!event.event_date) return;
          const [eYear, eMonth] = event.event_date.split('-');
          if (parseInt(eYear) === year && parseInt(eMonth) - 1 === month) {
            const total = getEventTotal(event);
            if (event.debt_type === 'lend') {
              lent += total;
            } else {
              borrowed += total;
            }
          }
        });

        const elBorrowed = document.getElementById('cal-borrowed');
        const elLent = document.getElementById('cal-lent');
        if(elBorrowed) elBorrowed.textContent = fmt(borrowed);
        if(elLent) elLent.textContent = fmt(lent);
      }

      // ═══════════════════════════
      // CUSTOM MONTH PICKER
      // ═══════════════════════════
      let pickerCurrentYear = new Date().getFullYear();

      function toggleMonthPicker() {
        const dropdown = document.getElementById('month-picker-dropdown');
        if (dropdown.classList.contains('hidden')) {
          dropdown.classList.remove('hidden');
          setTimeout(() => {
            dropdown.classList.remove('opacity-0', 'scale-95');
            dropdown.classList.add('opacity-100', 'scale-100');
          }, 10);
          renderPickerMonths();
        } else {
          closeMonthPicker();
        }
      }

      function closeMonthPicker() {
        const dropdown = document.getElementById('month-picker-dropdown');
        if (!dropdown) return;
        dropdown.classList.remove('opacity-100', 'scale-100');
        dropdown.classList.add('opacity-0', 'scale-95');
        setTimeout(() => {
          dropdown.classList.add('hidden');
        }, 200);
      }

      document.addEventListener('click', (e) => {
        const picker = document.getElementById('custom-month-picker');
        if (picker && !picker.contains(e.target)) {
          closeMonthPicker();
        }
      });

      function changePickerYear(delta) {
        pickerCurrentYear += delta;
        document.getElementById('picker-year-label').textContent = pickerCurrentYear;
        renderPickerMonths();
      }

      function selectPickerMonth(monthIndex) {
        const monthVal = pickerCurrentYear + '-' + String(monthIndex + 1).padStart(2, '0');
        goToCalendarMonth(monthVal);
        closeMonthPicker();
      }

      function renderPickerMonths() {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const grid = document.getElementById('picker-months-grid');
        grid.innerHTML = '';
        
        let activeYear, activeMonth;
        if(calendarInstance && calendarInstance.view) {
            const d = calendarInstance.view.currentStart;
            activeYear = d.getFullYear();
            activeMonth = d.getMonth();
        }

        months.forEach((month, index) => {
          const isActive = activeYear === pickerCurrentYear && activeMonth === index;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `py-2 rounded-xl text-sm font-medium transition-all ${isActive ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'}`;
          btn.textContent = month;
          btn.onclick = () => selectPickerMonth(index);
          grid.appendChild(btn);
        });
      }

      if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
          navigator.serviceWorker.register('/sw.js').then((registration) => {
            console.log('ServiceWorker registration successful with scope: ', registration.scope);
          }, (err) => {
            console.log('ServiceWorker registration failed: ', err);
          });
        });
      }

      // ═══════════════ LOFI CAT ANIMATION (JUMPING GIF) ═══════════════
      document.addEventListener('DOMContentLoaded', () => {
        const catContainer = document.getElementById('lofi-cat-container');
        const catBubble = document.getElementById('cat-speech-bubble');
        
        if (!catContainer) return;

        let isJumping = false;

        catContainer.addEventListener('click', () => {
          if (isJumping) return;
          isJumping = true; // Prevent multi clicks

          catBubble.textContent = 'Initiating SUPER JUMP in 3... 🚀';
          catBubble.classList.remove('opacity-0', 'translate-y-2');
          catBubble.classList.add('opacity-100', 'translate-y-0');

          let count = 3;
          const countdown = setInterval(() => {
            count--;
            if (count > 0) {
              catBubble.textContent = `Initiating SUPER JUMP in ${count}... 🚀`;
            } else {
              clearInterval(countdown);
              catBubble.textContent = 'LIFTOFF!!! ☄️';
              
              // Shoot up off screen!
              catContainer.style.transition = 'transform 1s cubic-bezier(0.1, 0.9, 0.2, 1)';
              catContainer.style.transform = 'translateY(-150vh) rotate(720deg)'; // Spin twice!

              setTimeout(() => {
                // Out of screen, hide bubble
                catBubble.classList.remove('opacity-100', 'translate-y-0');
                catBubble.classList.add('opacity-0', 'translate-y-2');
                
                // Wait 3s in the air
                setTimeout(() => {
                  catBubble.textContent = 'Incoming!! 🪂';
                  catBubble.classList.remove('opacity-0', 'translate-y-2');
                  catBubble.classList.add('opacity-100', 'translate-y-0');
                  
                  // Fall back down fast!
                  catContainer.style.transition = 'transform 0.6s cubic-bezier(0.8, 0, 1, 1)';
                  catContainer.style.transform = 'translateY(0) rotate(0deg)';
                  
                  // Crash land
                  setTimeout(() => {
                    catBubble.textContent = 'Nailed the landing! 😼';
                    
                    // Add a little squish effect on land
                    catContainer.style.transition = 'transform 0.2s ease-out';
                    catContainer.style.transform = 'scale(1.2, 0.8) translateY(20px)';
                    
                    setTimeout(() => {
                      catContainer.style.transform = 'scale(1, 1) translateY(0)';
                      
                      // End interaction
                      setTimeout(() => {
                        catBubble.classList.remove('opacity-100', 'translate-y-0');
                        catBubble.classList.add('opacity-0', 'translate-y-2');
                        isJumping = false;
                      }, 3000);
                    }, 200); // Un-squish
                  }, 600); // Time to fall
                }, 3000); // Air time
              }, 1000); // Ascent time
            }
          }, 800);
        });
      });
