<template>
  <BvnContainer id="home" class="full-height">
    <BvnRow class="text-center">
      <BvnCol>
        <b-carousel
          id="carousel-header"
          background="#ababab"
          img-width="1024"
          img-height="480"
          style="text-shadow: 3px 3px 3px #000;"
        >
          <b-carousel-slide :img-src="headerImage">
            <h1>{{ $t("home.title") }}</h1>
            <h5><i>{{ $t("home.subtitle") }}</i></h5>
          </b-carousel-slide>
        </b-carousel>
      </BvnCol>
    </BvnRow>
    <br>
    <BvnRow>
      <BvnCol>
        <div>
          <b>{{ $t("home.considerations") }}:</b>
        </div>
        <ul>
          <li>{{ $t("home.considerationsText[0]") }}</li>
          <li>{{ $t("home.considerationsText[1]") }}</li>
          <li>{{ $t("home.considerationsText[2]") }}</li>
          <li>{{ $t("home.considerationsText[3]") }}</li>
          <li>{{ $t("home.considerationsText[4]") }}</li>
          <li>{{ $t("home.considerationsText[5]") }}</li>
          <li>{{ $t("home.considerationsText[6]") }}</li>
        </ul>
      </BvnCol>
    </BvnRow>
    <br>
    <BvnRow>
      <BvnCol>
        <BvnAlert show variant="secondary">
          <b>{{ $t("home.troubleshootingText[0]") }}</b> {{ $t("home.troubleshootingText[1]") }}
        </BvnAlert>
      </BvnCol>
    </BvnRow>
    <br>
    <BvnRow class="text-center" align-v="center">
      <BvnCol>
        <BvnRow align-h="center">
          <b-button-group>
            <b-button to="oauth" variant="info">{{ $t("home.participate") }}</b-button>
          </b-button-group>
        </BvnRow>
        <br>
        <!--
        <b-row align-h="center">
          <b-button-group>
            <b-button to="admin-hub" variant="warning">Admin Panel</b-button>
          </b-button-group>
        </b-row>
        -->
      </BvnCol>
    </BvnRow>
  </BvnContainer>
</template>

<script>
import { BAlert as BvnAlert } from 'bootstrap-vue-next/components/BAlert';
import {
  BContainer as BvnContainer,
  BRow as BvnRow,
  BCol as BvnCol
} from 'bootstrap-vue-next/components/BContainer';
import ActionSender from '../services/ActionSender';

import HeaderImage from '../assets/image01.jpg';

export default {
  name: 'home',

  components: { BvnAlert, BvnContainer, BvnRow, BvnCol },

  data() {
    return {
      headerImage: HeaderImage
    }
  },

  computed: {
    loggedIn() {
      return this.$store.state.auth.status.loggedIn;
    },
    acceptedConsent() {
      return this.$store.state.hasAcceptedConsent;
    },
    currentUser() {
      return this.$store.state.auth.user;
    },
    isAdmin() {
      if (this.currentUser && this.currentUser.roles) {
        return this.currentUser.roles.includes('ROLE_ADMIN');
      }
      else {
        return false;
      }
    }
  },
  
  created() {
    let jwtData = this.$cookies.get('jwt');
    let userData = this.$cookies.get('userdata');
    let sessionFlow = this.$cookies.get('sessionflow');

    //console.log('Retrieving UserData from cookies', jwtData, userData, sessionFlow);
    
    if (jwtData) {
      localStorage.setItem('leticia-user', JSON.stringify(jwtData));
      
      this.$store.commit('auth/loginSuccess', jwtData);

      if (userData) this.$store.commit({ type: 'setUserData', data: userData });
      if (sessionFlow) this.$store.commit({ type: 'setSessionFlow', sessionFlow: sessionFlow });

      this.$cookies.remove('jwt');
      this.$cookies.remove('userdata');
      this.$cookies.remove('sessionflow');

      const sender = new ActionSender('UserLog');
      sender.userLog(true);
    }

    if (this.currentUser) {
      if (this.isAdmin) {
        this.$router.replace('/admin-hub');
      }
      else {
        this.$router.replace('/user-hub');
        /*
        if (this.acceptedConsent) {
          this.$router.replace('/user-hub');
        }
        else {
          this.$router.replace('consent');
        }
        */
      }
    }
  }
}
</script>

<style scoped>
.full-height {
  height: 100%;
}
</style>