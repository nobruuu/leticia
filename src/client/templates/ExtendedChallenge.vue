<template>
  <b-container fluid id="extended-challenge">
    <b-row class="full-window">
      <router-view id="current-stage"></router-view>
    </b-row>
    <!--
    <hr>
    <b-row>
      <div>
        TaskIndex: {{ taskIndex }}<br>
        StageIndex: {{ stageIndex }}<br>
        NewIndex: {{ newIndex }}
      </div>
      <div>
        <pre>{{ currentTasks }}</pre>
        <pre>{{ currentStages }}</pre>
      </div>
    </b-row>
    -->
  </b-container>
</template>

<script>
import Axios from 'axios';

import ActionSender from '../services/ActionSender';
import EventBus from '../modules/eventBus';
import { registerChallengeCoordinator, runChallengeTransition } from '../modules/challengeCoordinator';
import Timer from '../services/Timer';

import * as Constants from '../services/Constants';
import { deepCopy, isEmptyArray } from '../services/Utils';

export default {
  data() {
    return {
      stageOrder: [
        { path: '/extended-challenge/ready', query: { task: '' }},
        { path: '/extended-challenge/description', query: { task: '' }},
        { path: '/extended-challenge/taskform', query: { task: '', form: Constants.pretaskFormEx }},
        { path: '/extended-challenge/stroop', query: { task: '', form: `stroop-${Constants.pretaskForm}` }},
        { path: '/extended-challenge/instructions', query: { task: '' }},
        { path: '/extended-challenge/search', query: { task: '' }},
        { path: '/extended-challenge/stroop', query: { task: '', form: `stroop-${Constants.posttaskForm}` }},
        { path: '/extended-challenge/nasa-tlx', query: { task: '', form: 'nasatlx' }},
        { path: '/extended-challenge/taskform', query: { task: '', form: Constants.posttaskFormEx }}
      ],
      currentTasks: this.$store.getters.tasks,
      currentStages: this.$store.getters.stages,
      taskIndex: 0,
      stageIndex: 0,
      newIndex: this.$store.getters.stageIndex,
      taskAmount: 3
    }
  },

  computed: {
    currentUser() {
      return this.$store.state.auth.user;
    },
    loggedIn() {
      return this.$store.state.auth.status.loggedIn;
    }
  },

  // dgacitua definitions
  // next-stage: Advance to the following global action (Consent, Demographic, TypingTest, ShortChallenge, etc.)
  // next-challenge: Advance to the following step inside a challenge (Short or Extended)
  created() {
    registerChallengeCoordinator(this.advanceChallenge);
  },

  mounted() {
    return runChallengeTransition(() => this.initializeChallenge());
  },

  // The coordinator intentionally survives navigation to sibling substages.
  methods: {
    initializeChallenge() {
      // Begin the challenge from start
      if (this.$store.getters.stageIndex == null) {
        return this.importTasks()
          .then(() => {
            this.createStages();
            return this.startChallenge();
          })
          .catch(err => {
            console.error(err);
            alert('An error ocurred while loading the challenge [Code 462-SAVE]');
          });
      }
      // If user has already begun the challenge
      else {
        return this.loadChallenge();
      }
    },
    async advanceChallenge() {
      console.log('LETICIA Next Challenge!');

      try {
        this.nextChallenge();
        await this.saveUserData().catch(err => {
          this.$store.commit({ type: 'setStageIndex', amount: this.$store.getters.stageIndex - 1 });
          throw err;
        });
        await this.loadChallenge();
      }
      catch (err) {
        console.error(err);
        alert('An error ocurred while advancing the challenge [Code 462-SAVE]');
      }
    },
    importTasks() {
      return Axios.get(`${Constants.backendApiUrl}/tasks/shuffle?username=${this.currentUser.username}&num=${this.taskAmount}`)
        .then((res) => {
          this.$store.commit({ type: 'setTasks', tasks: res.data });
          console.log('Search Tasks loaded!');
          return Promise.resolve();
        })
        .catch((err) => {
          console.error(err);
          alert('An error ocurred while loading tasks [Code 462-E]');
          return Promise.reject();
        });
    },
    createStages() {
      let userStages = [];
      this.$store.getters.tasks.forEach(el1 => {
        this.stageOrder.forEach(el2 => {
          let newStage = deepCopy(el2);
          newStage.query.task = deepCopy(el1.searchTaskId);
          userStages.push(newStage);
        });
      });
                
      this.$store.commit({ type: 'setStages', stages: userStages });
      console.log('Challenge Stages loaded!');
    },
    async startChallenge() {
      this.$store.commit({ type: 'setStageIndex', amount: 0 });
      let nextStage = this.$store.getters.stages[this.$store.getters.stageIndex];
      console.log('StartChallenge!', nextStage);
      await this.saveUserData();
      return this.$router.replace(nextStage);
    },
    nextChallenge() {
      this.$store.commit({ type: 'nextStageIndex' });
      console.log('NextChallenge!', this.$store.getters.stageIndex);
    },
    loadChallenge() {
      let idx = this.$store.getters.stageIndex;
      let len = this.$store.getters.stages.length;

      if (idx < len) {
        let nextStage = this.$store.getters.stages[this.$store.getters.stageIndex];
        console.log('LoadChallenge!', this.$store.getters.stageIndex, nextStage);
        return this.$router.replace(nextStage);
      }
      else {
        EventBus.$emit('leticia-timer-stop');
        EventBus.$emit('leticia-next-stage');
      }
    },
    saveUserData() {
      let userdata = {
        username: this.currentUser.username,
        state: this.$store.getters.userData,
        sessionFlow: this.$store.getters.sessionFlow
      };

      return Axios.post(`${Constants.backendApiUrl}/userdata/${this.currentUser.username}`, userdata)
        .then(res => console.log('UserData saved on server!'))
        .catch(err => {
          console.error('Error while saving UserData on server', err);
          throw err;
        });
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
</style>