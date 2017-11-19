package core;


import java.sql.Date;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Observable;
import java.util.Observer;
import org.apache.log4j.Logger;

import api.ApiErrorFactory;
import ntp.NTP;
import settings.Settings;
import utils.ObserverMessage;
import utils.TransactionTimestampComparator;
import at.AT_Block;
import at.AT_Constants;
import at.AT_Controller;

import controller.Controller;
import core.account.PrivateKeyAccount;
import core.block.Block;
import core.block.GenesisBlock;
import core.block.BlockFactory;
import core.transaction.Transaction;
import datachain.DCSet;
import lang.Lang;
import network.Peer;
import network.message.Message;
import network.message.MessageFactory;
import network.message.SignaturesMessage;

public class BlockGenerator extends Thread implements Observer
{	
	
	static Logger LOGGER = Logger.getLogger(BlockGenerator.class.getName());
	
	private static final int MAX_BLOCK_SIZE = BlockChain.HARD_WORK?20000:1000;
	private static final int MAX_BLOCK_SIZE_BYTE = 
			BlockChain.HARD_WORK?BlockChain.MAX_BLOCK_BYTES:BlockChain.MAX_BLOCK_BYTES>>2;

	static final int FLUSH_TIMEPOINT = BlockChain.GENERATING_MIN_BLOCK_TIME_MS - (BlockChain.GENERATING_MIN_BLOCK_TIME_MS>>2);
	static final int WIN_TIMEPOINT = BlockChain.GENERATING_MIN_BLOCK_TIME_MS>>2;
	private PrivateKeyAccount acc_winner;
	private List<Block> lastBlocksForTarget;
	private byte[] solvingReference;
	
	private List<PrivateKeyAccount> cachedAccounts;
	
	private ForgingStatus forgingStatus = ForgingStatus.FORGING_DISABLED;
	private boolean walletOnceUnlocked = false;
	private static int status = 0;

	private int orphanto = 0;
	
	public enum ForgingStatus {
	    
		FORGING_DISABLED(0, Lang.getInstance().translate("Forging disabled") ),
		FORGING_ENABLED(1, Lang.getInstance().translate("Forging enabled")),
		FORGING(2, Lang.getInstance().translate("Forging")),
		FORGING_WAIT(3, Lang.getInstance().translate("Forging awaiting another peer sync"));
		
		private final int statuscode;
		private String name;

		ForgingStatus(int status, String name) {
			 statuscode = status;
			 this.name = name;
		}

		public int getStatuscode() {
			return statuscode;
		}

		public String getName() {
			return name;
		}

	}
	
    public ForgingStatus getForgingStatus()
    {
        return forgingStatus;
    }	

    public static int getStatus()
    {
        return status;
    }	

    public void setOrphanTo(int height)
    {
    	this.orphanto =  height;
    }	

    public static String viewStatus()
    {
    	
		switch (status) {
		case -1:
			return "-1 STOPed";
		case 1:
			return "1 FLUSH, WAIT";
		case 2:
			return "2 FLUSH, TRY";
		case 3:
			return "3 UPDATE";
		case 31:
			return "31 UPDATE SAME";
		case 4:
			return "4 PREPARE MAKING";
		case 5:
			return "5 GET WIN ACCOUNT";
		case 6:
			return "6 WAIT BEFORE MAKING";
		case 7:
			return "7 MAKING NEW BLOCK";
		case 8:
			return "8 BROADCASTING";
		case 9:
			return "9 ORPHAN TO";
		default:
			return "0 WAIT";
		}
    }	

	public BlockGenerator(boolean withObserve)
	{
		if(Settings.getInstance().isGeneratorKeyCachingEnabled())
		{
			this.cachedAccounts = new ArrayList<PrivateKeyAccount>();
		}
		
		if (withObserve) addObserver();
	}

	public void addObserver() {
		new Thread()
		{
			@Override
			public void run() {
				
				//WE HAVE TO WAIT FOR THE WALLET TO ADD THAT LISTENER.
				while(!Controller.getInstance().doesWalletExists() || !Controller.getInstance().doesWalletDatabaseExists())
				{
					try {
						Thread.sleep(500);
					} catch (InterruptedException e) {
//						does not matter
					}
				}
				
				Controller.getInstance().addWalletListener(BlockGenerator.this);
				syncForgingStatus();
			}
		}.start();
		Controller.getInstance().addObserver(this);
	}
	
	public void addUnconfirmedTransaction(Transaction transaction)
	{
		this.addUnconfirmedTransaction(DCSet.getInstance(), transaction);
	}
	public void addUnconfirmedTransaction(DCSet db, Transaction transaction) 
	{
		//ADD TO TRANSACTION DATABASE 
		db.getTransactionMap().add(transaction);
	}
	
	public List<Transaction> getUnconfirmedTransactions()
	{
		return new ArrayList<Transaction>(DCSet.getInstance().getTransactionMap().getValues());
	}
	
	private List<PrivateKeyAccount> getKnownAccounts()
	{
		//CHECK IF CACHING ENABLED
		if(Settings.getInstance().isGeneratorKeyCachingEnabled())
		{
			List<PrivateKeyAccount> privateKeyAccounts = Controller.getInstance().getPrivateKeyAccounts();
			
			//IF ACCOUNTS EXISTS
			if(privateKeyAccounts.size() > 0)
			{
				//CACHE ACCOUNTS
				this.cachedAccounts = privateKeyAccounts;
			}
			
			//RETURN CACHED ACCOUNTS
			return this.cachedAccounts;
		}
		else
		{
			//RETURN ACCOUNTS
			return Controller.getInstance().getPrivateKeyAccounts();
		}
	}
	
	public void setForgingStatus(ForgingStatus status)
	{
		if(forgingStatus != status)
		{
			forgingStatus = status;
			Controller.getInstance().forgingStatusChanged(forgingStatus);
		}
	}
	
	
	public void run()
	{

		Controller ctrl = Controller.getInstance();
		BlockChain bchain = ctrl.getBlockChain();
		DCSet dcSet = DCSet.getInstance();

		long timeTmp;
		long timePoint = 0;
		long flushPoint = 0;
		Block waitWin = null;
		long timeUpdate = 0;

		while(!ctrl.isOnStopping())
		{
			try {

				status = 0;
				
				try {
					Thread.sleep(100);
				}
				catch (InterruptedException e) {
				}
				
				if (ctrl.isOnStopping()) {
					status = -1;
					return;
				}
				
				if (orphanto>0) {
					status = 9;
					ForgingStatus forgingStatus = ctrl.getForgingStatus();
					ctrl.setForgingStatus(ForgingStatus.FORGING_WAIT);
					try
					{
						ctrl.clearWaitWinBufferProcessed();
						while (bchain.getHeight(dcSet) > orphanto) {
							ctrl.orphanInPipe(bchain.getLastBlock(dcSet));
						}
					}
					catch(Exception e)
					{
					}

					ctrl.setForgingStatus(forgingStatus);
					ctrl.checkStatusAndObserve(0);
					continue;
				}
				
				timeTmp = bchain.getTimestamp(dcSet) + BlockChain.GENERATING_MIN_BLOCK_TIME_MS;
				if (timeTmp > NTP.getTime())
					continue;
				
				if (timePoint != timeTmp) {
					timePoint = timeTmp;
					Timestamp timestampPoit = new Timestamp(timePoint);
					LOGGER.info("+ + + + + START GENERATE POINT on " + timestampPoit);

					flushPoint = FLUSH_TIMEPOINT + timePoint;
					this.solvingReference = null;

					// GET real HWeight
					ctrl.pingAllPeers(false);						
					
				}
				
				// is WALLET
				if(ctrl.doesWalletExists()) {
	
					//CHECK IF WE HAVE CONNECTIONS and READY to GENERATE
					syncForgingStatus();
					
					//Timestamp timestamp = new Timestamp(NTP.getTime());
					//LOGGER.info("NTP.getTime() " + timestamp);
					
					waitWin = bchain.getWaitWinBuffer();

					if (waitWin == null && timePoint + BlockChain.WIN_BLOCK_BROADCAST_WAIT_MS < NTP.getTime()
						&& forgingStatus == ForgingStatus.FORGING // FORGING enabled
							&& (this.solvingReference == null // AND GENERATING NOT MAKED
								|| !Arrays.equals(this.solvingReference, dcSet.getBlockMap().getLastBlockSignature())
							)
						)
					{
						
						/////////////////////////////// TRY FORGING ////////////////////////
		
						if(ctrl.isOnStopping()) {
							status = -1;
							return;
						}
		
						//SET NEW BLOCK TO SOLVE
						this.solvingReference = dcSet.getBlockMap().getLastBlockSignature();
						Block solvingBlock = dcSet.getBlockMap().get(this.solvingReference);
						
						//set max block
						//if (BlockChain.BLOCK_COUNT >0)	if (solvingBlock.getHeight(dcSet) > BlockChain.BLOCK_COUNT ) return;
		
						if(ctrl.isOnStopping()) {
							status = -1;
							return;
						}
		
						/*
						 * нужно сразу взять транзакции которые бедум в блок класть - чтобы
						 * значть их ХЭШ - 
						 * тоже самое и AT записями поидее
						 * и эти хэши закатываем уже в заголвок блока и подписываем
						 * после чего делать вычисление значения ПОБЕДЫ - она от подписи зависит
						 * если победа случиласть то
						 * далее сами трнзакции кладем в тело блока и закрываем его
						 */
						/*
						 * нет не  так - вычисляеи победное значение и если оно выиграло то
						 * к нему транзакции собираем
						 * и время всегда одинаковое
						 * 
						 */
		
						status = 4;
						
						//GENERATE NEW BLOCKS
						this.lastBlocksForTarget = bchain.getLastBlocksForTarget(dcSet);				
						this.acc_winner = null;
						
						List<Transaction> unconfirmedTransactions = null;
						byte[] unconfirmedTransactionsHash = null;
						long max_winned_value = 0;
						long winned_value;				
						int height = bchain.getHeight(dcSet) + 1;
						long target = bchain.getTarget(dcSet);
		
						//PREVENT CONCURRENT MODIFY EXCEPTION
						List<PrivateKeyAccount> knownAccounts = this.getKnownAccounts();
						synchronized(knownAccounts)
						{
							
							status = 5;
							
							for(PrivateKeyAccount account: knownAccounts)
							{
								
								winned_value = account.calcWinValue(dcSet, bchain, this.lastBlocksForTarget, height, target);
								if(winned_value < 1l)
									continue;
								
								if (winned_value > max_winned_value) {
									//this.winners.put(account, winned_value);
									acc_winner = account;
									max_winned_value = winned_value;
									
								}
							}
						}
						
						if(acc_winner != null) {
							
							if (ctrl.isOnStopping()) {
								status = -1;
								return;
							}
			
							int wait_new_block_broadcast = (int)((WIN_TIMEPOINT>>1) + WIN_TIMEPOINT * 4 * (target - max_winned_value) / target);
							
							if (wait_new_block_broadcast > 0) {
	
								status = 6;
								
								LOGGER.info("@@@@@@@@ wait for new winner and BROADCAST: " + wait_new_block_broadcast/1000);
								// SLEEP and WATCH break
								long wait_steep = wait_new_block_broadcast / 100;
								boolean newWinner = false;
								do {
									try
									{
										Thread.sleep(100);
									}
									catch (InterruptedException e) 
									{
									}
									
									if (ctrl.isOnStopping()) {
										status = -1;
										return;
									}
	
									waitWin = bchain.getWaitWinBuffer();
									if (waitWin != null && waitWin.calcWinValue(dcSet) > max_winned_value) {
										// NEW WINNER received
										newWinner = true;
										this.solvingReference = null;
										break;
									}
											
								} while (wait_steep-- > 0 && NTP.getTime() < timePoint + BlockChain.GENERATING_MIN_BLOCK_TIME_MS);
	
								if (newWinner)
								{
									LOGGER.info("NEW WINER RECEIVED - drop my block");
									continue;
								}
							}
	
							// MAKING NEW BLOCK
							status = 7;
			
							// GET VALID UNCONFIRMED RECORDS for current TIMESTAMP
							LOGGER.info("GENERATE my BLOCK");
			
							unconfirmedTransactions = getUnconfirmedTransactions(dcSet, timePoint);
							// CALCULATE HASH for that transactions
							byte[] winnerPubKey = acc_winner.getPublicKey();
							byte[] atBytes = null;
							unconfirmedTransactionsHash = Block.makeTransactionsHash(winnerPubKey, unconfirmedTransactions, atBytes);
			
							//ADD TRANSACTIONS
							//this.addUnconfirmedTransactions(dcSet, block);
							Block generatedBlock = generateNextBlock(dcSet, acc_winner, 
									solvingBlock, unconfirmedTransactionsHash);
							generatedBlock.setTransactions(unconfirmedTransactions);
							
							//PASS BLOCK TO CONTROLLER
							///ctrl.newBlockGenerated(block);
							LOGGER.info("bchain.setWaitWinBuffer, size: " + generatedBlock.getTransactionCount());
							if (bchain.setWaitWinBuffer(dcSet, generatedBlock)) {
			
								// need to BROADCAST
								status = 8;
								ctrl.broadcastWinBlock(generatedBlock, null);
								status = 0;

							} else {
								LOGGER.info("my BLOCK is weak ((...");
							}
						}
					}
				}
				
				////////////////////////////  FLUSH NEW BLOCK /////////////////////////
	
				// try solve and flush new block from Win Buffer		
				waitWin = bchain.getWaitWinBuffer();
				if (waitWin != null) {

					this.solvingReference = null;

					// FLUSH WINER to DB MAP
					LOGGER.info("wait to FLUSH WINER to DB MAP " + (flushPoint - NTP.getTime())/1000);
	
					status = 1;
	
					while (flushPoint > NTP.getTime()) {
						try
						{
							Thread.sleep(100);
						}
						catch (InterruptedException e) 
						{
						}
	
						if (ctrl.isOnStopping()) {
							status = -1;
							return;
						}
					}
					
					// FLUSH WINER to DB MAP
					LOGGER.info("TRY to FLUSH WINER to DB MAP");
	
					try {
						
						status = 2;
						if (!ctrl.flushNewBlockGenerated()) {
							// NEW BLOCK not FLUSHED
							LOGGER.error("NEW BLOCK not FLUSHED");
							continue;
						}
						status = 0;

						if (ctrl.isOnStopping()) {
							status = -1;
							return;
						}
							
					} catch (Exception e) {
						// TODO Auto-generated catch block
						if (ctrl.isOnStopping()) {
							status = -1;
							return;
						}
						// if FLUSH out of memory
						bchain.clearWaitWinBuffer();
						LOGGER.error(e.getMessage(), e);
					}
				}
	
				////////////////////////// UPDATE ////////////////////
				//CHECK IF WE ARE NOT UP TO DATE
				waitWin = bchain.getWaitWinBuffer();
				if (waitWin == null) {
					
					timeUpdate = timePoint + (BlockChain.GENERATING_MIN_BLOCK_TIME_MS>>1) + BlockChain.WIN_BLOCK_BROADCAST_WAIT_MS - NTP.getTime();

					if (timeUpdate > 0) {
						//// still early FOR UPDATE
						continue;
					}

					/// CHECK PEERS SAME ME 
					ctrl.checkStatusAndObserve(0);
					if(timeUpdate + BlockChain.GENERATING_MIN_BLOCK_TIME_MS < 0 && !ctrl.needUpToDate()) {
						//////// PAT SITUATION ////////////
						ctrl.checkStatusAndObserve(-1);
						if (ctrl.needUpToDate()) {
							status = 31;
							ctrl.orphanInPipe(ctrl.getLastBlock());
						}
					}					
					
					/// CHECK PEERS HIGHER 
					ctrl.checkStatusAndObserve(0);
					if (timeUpdate < 0 && ctrl.needUpToDate()) {
						if (ctrl.isOnStopping()) {
							status = -1;
							return;
						}
						
						status = 3;
						ctrl.update(0);
						status = 0;

						if (ctrl.isOnStopping()) {
							status = -1;
							return;
						}	
					}
				}
				
				if (ctrl.isOnStopping()) {
					status = -1;
					return;
				}
					
			} catch (Exception e) {
				if (ctrl.isOnStopping()) {
					status = -1;
					return;
				}
				LOGGER.error(e.getMessage(), e);
				this.solvingReference = null;
				bchain.clearWaitWinBuffer();

			}
		}
	}
	
	public static Block generateNextBlock(DCSet dcSet, PrivateKeyAccount account,
			Block parentBlock, byte[] transactionsHash)
	{
		
		int version = parentBlock.getNextBlockVersion(dcSet);
		byte[] atBytes;
		if ( version > 1 )
		{
			AT_Block atBlock = AT_Controller.getCurrentBlockATs( AT_Constants.getInstance().MAX_PAYLOAD_FOR_BLOCK(
					parentBlock.getHeight(dcSet)) , parentBlock.getHeight(dcSet) + 1 );
			atBytes = atBlock.getBytesForBlock();
		} else {
			atBytes = new byte[0];
		}

		//CREATE NEW BLOCK
		Block newBlock = BlockFactory.getInstance().create(version, parentBlock.getSignature(), account,
				transactionsHash, atBytes);
		// SET GENERATING BALANCE here
		newBlock.setCalcGeneratingBalance(dcSet);
		newBlock.sign(account);
		
		return newBlock;

	}
	
	public static List<Transaction> getUnconfirmedTransactions(DCSet db, long timestamp)
	{
		
		long timrans1 = System.currentTimeMillis();
					
		//CREATE FORK OF GIVEN DATABASE
		DCSet newBlockDb = db.fork();
		Controller ctrl = Controller.getInstance();
					
		//ORDER TRANSACTIONS BY FEE PER BYTE
		DCSet dcSet = DCSet.getInstance();
		
		long start = System.currentTimeMillis();
		LOGGER.error("get orderedTransactions");
		List<Transaction> orderedTransactions = new ArrayList<Transaction>(dcSet.getTransactionMap().getValues());
		long tickets = System.currentTimeMillis() - start;
		LOGGER.error(" time " + tickets);

		// TODO make SORT by FEE to!
		// toBYTE / FEE + TIMESTAMP !!
		////Collections.sort(orderedTransactions, new TransactionFeeComparator());
		// sort by TIMESTAMP
		Collections.sort(orderedTransactions, new TransactionTimestampComparator());
		long tickets2 = System.currentTimeMillis() - start - tickets;
		LOGGER.error("sort time " + tickets2);
		start = System.currentTimeMillis();
		
		//Collections.sort(orderedTransactions, Collections.reverseOrder());
		
		List<Transaction> transactionsList = new ArrayList<Transaction>();

		boolean transactionProcessed;
		long totalBytes = 0;
		int count = 0;

		do
		{
			transactionProcessed = false;
						
			for(Transaction transaction: orderedTransactions)
			{
								
				if (ctrl.isOnStopping()) {
					return null;
				}

				try{

					//CHECK TRANSACTION TIMESTAMP AND DEADLINE
					if(transaction.getTimestamp() > timestamp || transaction.getDeadline() < timestamp) {
						// OFF TIME
						// REMOVE FROM LIST
						transactionProcessed = true;
						orderedTransactions.remove(transaction);
						break;
					}
					
					//CHECK IF VALID
					if(!transaction.isSignatureValid()) {
						// INVALID TRANSACTION
						// REMOVE FROM LIST
						transactionProcessed = true;
						orderedTransactions.remove(transaction);
						break;
					}
						
					transaction.setDB(newBlockDb, false);
					
					if (transaction.isValid(newBlockDb, null) != Transaction.VALIDATE_OK) {
						// INVALID TRANSACTION
						// REMOVE FROM LIST
						transactionProcessed = true;
						orderedTransactions.remove(transaction);
						break;
					}
														
					//CHECK IF ENOUGH ROOM
					totalBytes += transaction.getDataLength(false);

					if(totalBytes > MAX_BLOCK_SIZE_BYTE
							|| ++count> MAX_BLOCK_SIZE)
						break;
					
					////ADD INTO LIST
					transactionsList.add(transaction);
								
					//REMOVE FROM LIST
					orderedTransactions.remove(transaction);
								
					//PROCESS IN NEWBLOCKDB
					transaction.process(newBlockDb, null, false);
								
					//TRANSACTION PROCESSES
					transactionProcessed = true;
										
					// GO TO NEXT TRANSACTION
					break;
						
				} catch (Exception e) {
					
					if (ctrl.isOnStopping()) {
						return null;
					}

                    transactionProcessed = true;

                    LOGGER.error(e.getMessage(), e);
                    //REMOVE FROM LIST

                    break;                    
				}
				
			}
		}
		while(count < MAX_BLOCK_SIZE && totalBytes < MAX_BLOCK_SIZE_BYTE && transactionProcessed == true);


		LOGGER.debug("get Unconfirmed Transactions = " + (System.currentTimeMillis() - start) +"milsec for trans: " + transactionsList.size() );
		start = System.currentTimeMillis();

		// sort by TIMESTAMP
		Collections.sort(transactionsList,  new TransactionTimestampComparator());

		LOGGER.debug("sort 2 Unconfirmed Transactions =" + (System.currentTimeMillis() - start) +"milsec for trans: " + transactionsList.size() );
		
		return transactionsList;
	}	
	
	@Override
	public void update(Observable arg0, Object arg1) {
	ObserverMessage message = (ObserverMessage) arg1;
		
		if(message.getType() == ObserverMessage.WALLET_STATUS || message.getType() == ObserverMessage.NETWORK_STATUS)
		{
			//WALLET ONCE UNLOCKED? WITHOUT UNLOCKING FORGING DISABLED 
			if(!walletOnceUnlocked &&  message.getType() == ObserverMessage.WALLET_STATUS)
			{
				walletOnceUnlocked = true;
			}
			
			if(walletOnceUnlocked)
			{
				// WALLET UNLOCKED OR GENERATORCACHING TRUE
				syncForgingStatus();
			}
		}
		
	}
	
	public void syncForgingStatus()
	{
		
		if(!Settings.getInstance().isForgingEnabled() || getKnownAccounts().size() == 0) {
			setForgingStatus(ForgingStatus.FORGING_DISABLED);
			return;
		}
		
		Controller ctrl = Controller.getInstance();
		int status = ctrl.getStatus();
		//CONNECTIONS OKE? -> FORGING
		// CONNECTION not NEED now !!
		// TARGET_WIN will be small
		if(status != Controller.STATUS_OK
				///|| ctrl.isProcessingWalletSynchronize()
				) {
			setForgingStatus(ForgingStatus.FORGING_ENABLED);
			return;
		}

		// NOT NEED to wait - TARGET_WIN will be small
		if (Controller.getInstance().isReadyForging())
			setForgingStatus(ForgingStatus.FORGING);
		else
			setForgingStatus(ForgingStatus.FORGING_WAIT);
	}
	
}
