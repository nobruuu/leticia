<template>
  <b-container fluid id="display-page" class="full-window">
    <!--
    <iframe id="page-iframe" ref="pageIframe" class="display-iframe" :src="pageUrl" @load="iframeLoaded"></iframe>
    -->
    <div v-if="renderPage" id="container" class="container-iframe">
      <iframe id="page-iframe" ref="pageIframe" class="display-iframe" sandbox="allow-same-origin" :src="pageUrl"></iframe>
    </div>
    <div v-else>
      <h2>{{ $t("search.displayPage.message") }}</h2>
    </div>
  </b-container>
</template>

<script>
import { throttle } from 'lodash';

import * as Constants from '../../services/Constants';
import { deepCopy, getNestedValue } from '../../services/Utils';
import EventBus from '../../modules/eventBus';

import MouseHandler from '../../trackers/MouseHandler';
import ScrollHandler from '../../trackers/ScrollHandler';
import ActionSender from '../../services/ActionSender';

export default {
  data() {
    return {
      pageUrl: '',
      pageId: '',
      doc: {},
      iframeElement: null,
      renderPage: false,
      mHandler: new MouseHandler('Page'),
      scHandler: new ScrollHandler('Page'),
      sender: new ActionSender('Page'),
      mouseBuffer: [],
      mouseBufferInterval: null,
      mouseMoveListener: null,
      mouseClickListener: null,
      scrollListener: null
    }
  },

  async mounted() {
    this.visitPage();
    await this.$nextTick();
    this.startTracking();
  },

  watch: {
    async '$route.query.id'() {
      this.stopTracking();
      this.visitPage();
      await this.$nextTick();
      this.startTracking();
    }
  },

  beforeDestroy() {
    this.stopTracking();
    EventBus.$emit('leticia-bookmark-button-status', { status: false, doc: null });
    EventBus.$emit('leticia-current-task', { currentTask: false });
  },

  methods: {
    startTracking() {
      if (this._isDestroyed || !this.renderPage || !this.$refs.pageIframe) return;
      this.mouseMoveListener = throttle(this.move, 250);
      this.mouseClickListener = this.click;
      this.scrollListener = throttle(this.scroll, 250);
      this.iframeElement = this.$refs.pageIframe;
      this.iframeElement.onload = () => {
        const iwin = this.iframeElement.contentWindow;
        iwin.addEventListener('mousemove', this.mouseMoveListener);
        iwin.addEventListener('click', this.mouseClickListener);
        iwin.addEventListener('scroll', this.scrollListener);
      };
      this.mouseBufferInterval = setInterval(() => this.sendMouseBuffer(), 15000);
    },
    stopTracking() {
      const iwin = this.iframeElement && this.iframeElement.contentWindow;
      if (iwin) {
        iwin.removeEventListener('mousemove', this.mouseMoveListener);
        iwin.removeEventListener('click', this.mouseClickListener);
        iwin.removeEventListener('scroll', this.scrollListener);
        this.iframeElement.onload = null;
      }
      if (this.mouseMoveListener) this.mouseMoveListener.cancel();
      if (this.scrollListener) this.scrollListener.cancel();
      clearInterval(this.mouseBufferInterval);
      this.mouseBufferInterval = null;
      this.iframeElement = null;
    },
    visitPage() {
      const doc = this.$store.getters.lastVisitedDoc;
      const id = this.$route.query.id;
      this.renderPage = typeof id === 'string' && !!id &&
        !!doc && doc.docId_s === id && !!doc.path_s;
      this.doc = this.renderPage ? doc : {};
      this.pageId = this.renderPage ? id : '';
      this.pageUrl = this.renderPage ? `${Constants.backendUrl}${doc.path_s}` : '';
      EventBus.$emit('leticia-bookmark-button-status', { status: this.renderPage, doc: this.renderPage ? doc : null });
      EventBus.$emit('leticia-current-task', { currentTask: this.renderPage });
      console.log('Visiting page!', this.pageId, this.pageUrl);
    },
    goBack() {
      window.history.length > 1 ? this.$router.go(-1) : this.$router.push('/')
    },
    move(evt) {
      let mact = this.mHandler.moveElement(evt, this.iframeElement.contentDocument.documentElement);
      this.mouseBuffer.push(mact);
    },
    click(evt) {
      let mact = this.mHandler.clickElement(evt, this.iframeElement.contentDocument.documentElement);
      this.mouseBuffer.push(mact);
    },
    scroll(evt) {
      let scr = this.scHandler.scrollElement(evt, this.iframeElement.contentDocument.documentElement);

      this.sender.sendScrollAction(scr)
        .then(res => console.log(res.data))
        .catch(err => console.error(err));
    },
    sendMouseBuffer() {
      if (this.mouseBuffer.length > 0) {
        let tempBuffer = deepCopy(this.mouseBuffer);
        this.mouseBuffer.length = 0;

        this.sender.sendMouseBuffer(tempBuffer)
          .then(res => console.log(res.data))
          .catch(err => console.error(err));
      }
    }
  }
}
</script>

<style scoped>
.full-window {
  width: 100%;
  height: 100%;
  padding: 0;
}

.container-iframe {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
}

.display-iframe {
  flex-grow: 1;
  border: none;
  margin: 0;
  padding: 0;
}
</style>