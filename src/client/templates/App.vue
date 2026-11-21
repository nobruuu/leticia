<template>
  <b-container fluid id="leticia-app" class="leticia-app d-flex flex-column align-items-center">
    <navbar id="leticia-navbar" class="leticia-navbar"></navbar>
    <router-view id="leticia-content" class="leticia-content d-flex flex-column align-items-stretch"></router-view>
  </b-container>
</template>

<script>
import Axios from 'axios';

import * as Constants from '../services/Constants';
import EventBus from '../modules/eventBus';
import { stopChallengeCoordinator } from '../modules/challengeCoordinator';
import ActionSender from '../services/ActionSender';
import Navbar from './Navbar.vue';

export default {
  components: {
    navbar: Navbar
  },

  data() {
    return {
      timer: null,
      globalTimer: null
    }
  },

  computed: {
    remainingTime() {
      return this.$store.state.timerTime;
    },
    loggedIn() {
      return this.$store.state.auth.status.loggedIn;
    },
    currentUser() {
      return this.$store.state.auth.user;
    }
  },

  created() {
    let advancing = false;
    EventBus.$on('leticia-next-stage', async () => {
      if (advancing) return;
      advancing = true;
      try {
        await stopChallengeCoordinator();
        console.log('LETICIA Next Stage!');
        const previousFlowIndex = this.$store.getters.flowIndex;
        if (this.$store.getters.flowIndex >= 0) this.$store.commit({ type: 'nextFlowIndex' });
        else this.$store.commit({ type: 'setFlowIndex', amount: 0 });

        let nextFlowStage = this.$store.getters.sessionFlow.stages[this.$store.getters.flowIndex].path;
        let nextFlowParams = this.$store.getters.sessionFlow.stages[this.$store.getters.flowIndex].params;
        let nextFlowTimeLimit = this.$store.getters.sessionFlow.stages[this.$store.getters.flowIndex].timeLimit;

        let userdata = {
          username: this.currentUser.username,
          state: this.$store.getters.userData,
          sessionFlow: this.$store.getters.sessionFlow
        };

        if (nextFlowTimeLimit > 0) {
          EventBus.$emit('leticia-timer-create', { totalTime: nextFlowTimeLimit * 60 });
        }

        // Timer creation updates state; capture it before persisting the transition.
        userdata.state = this.$store.getters.userData;
        await Axios.post(`${Constants.backendApiUrl}/userdata/${this.currentUser.username}`, userdata)
          .catch(err => {
            this.$store.commit({ type: 'setFlowIndex', amount: previousFlowIndex });
            EventBus.$emit('leticia-timer-stop');
            throw err;
          });
        await this.$router.replace({ path: nextFlowStage });
      }
      catch (err) {
        console.error('Error while advancing session flow', err);
        alert('An error ocurred while saving session progress [Code 462-SAVE]');
      }
      finally {
        advancing = false;
      }
    });

    EventBus.$on('leticia-timeout', (detail) => {
      if (advancing) return;
      alert(this.$i18n.t('error.timeout'));

      const sender = new ActionSender('Timeout');
      let msg = { type: 'TimeoutTriggered' };
      sender.sendGenericAction(msg);

      EventBus.$emit('leticia-next-stage');
    });
  }
}
</script>

<style scoped>
.leticia-app {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
}

.leticia-navbar {
  width: 100%;
  height: 56px;
}

.leticia-content {
  margin: 0;
  padding: 5px 5px 5px 5px;
}
</style>
