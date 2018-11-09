package org.erachain.gui.items.imprints;

import org.erachain.controller.Controller;
import org.erachain.core.item.imprints.ImprintCls;
import org.erachain.gui.Split_Panel;
import org.erachain.gui.library.MTable;
import org.erachain.gui.models.WalletItemImprintsTableModel;
import org.erachain.lang.Lang;
import org.erachain.utils.TableMenuPopupUtil;

import javax.swing.*;
import javax.swing.event.*;
import javax.swing.table.TableColumn;
import javax.swing.table.TableRowSorter;
import java.awt.*;
import java.awt.event.*;

public class My_Imprints_Tab extends Split_Panel {

    private static final long serialVersionUID = 1L;
    final MTable table;
    protected int row;
    /**
     *
     */
    WalletItemImprintsTableModel assetsModel;
    RowSorter<WalletItemImprintsTableModel> sorter;

    public My_Imprints_Tab() {
        super("My_Imprints_Tab");

        this.setName("My Hashes");
        searthLabel_SearchToolBar_LeftPanel.setText(Lang.getInstance().translate("Search") + ":  ");
        // not show buttons
        button1_ToolBar_LeftPanel.setVisible(false);
        button2_ToolBar_LeftPanel.setVisible(false);
        jButton1_jToolBar_RightPanel.setVisible(false);
        jButton2_jToolBar_RightPanel.setVisible(false);

        //TABLE
        assetsModel = new WalletItemImprintsTableModel();
        table = new MTable(assetsModel);
        //assetsModel.getAsset(row)
        //POLLS SORTER
        sorter = new TableRowSorter<WalletItemImprintsTableModel>(assetsModel);
        table.setRowSorter(sorter);
//	Map<Integer, Integer> indexes = new TreeMap<Integer, Integer>();
//	CoreRowSorter sorter = new CoreRowSorter(assetsModel, indexes);
//	table.setRowSorter(sorter);

        //CHECKBOX FOR DIVISIBLE
//	TableColumn divisibleColumn = table.getColumnModel().getColumn(WalletItemAssetsTableModel.COLUMN_DIVISIBLE);
//	divisibleColumn.setCellRenderer(table.getDefaultRenderer(Boolean.class));

        //CHECKBOX FOR CONFIRMED
//	TableColumn confirmedColumn = table.getColumnModel().getColumn(WalletItemAssetsTableModel.COLUMN_CONFIRMED);
//	confirmedColumn.setCellRenderer(table.getDefaultRenderer(Boolean.class));

        //CHECKBOX FOR FAVORITE
//	TableColumn favoriteColumn = table.getColumnModel().getColumn(WalletItemAssetsTableModel.COLUMN_FAVORITE);
//	favoriteColumn.setCellRenderer(table.getDefaultRenderer(Boolean.class));


// column #1
        TableColumn column1 = table.getColumnModel().getColumn(WalletItemImprintsTableModel.COLUMN_KEY);//.COLUMN_CONFIRMED);
        column1.setMinWidth(1);
        column1.setMaxWidth(1000);
        column1.setPreferredWidth(50);
// column #1
        TableColumn column2 = table.getColumnModel().getColumn(WalletItemImprintsTableModel.COLUMN_CONFIRMED);//.COLUMN_CONFIRMED);
        column2.setMinWidth(50);
        column2.setMaxWidth(1000);
        column2.setPreferredWidth(50);
        // column #1
// column #1
        TableColumn column4 = table.getColumnModel().getColumn(WalletItemImprintsTableModel.COLUMN_FAVORITE);//.COLUMN_KEY);//.COLUMN_CONFIRMED);
        column4.setMinWidth(50);
        column4.setMaxWidth(1000);
        column4.setPreferredWidth(50);


        // EVENTS on CURSOR
        table.getSelectionModel().addListSelectionListener(new My_Tab_Listener());
// show	
        this.jTable_jScrollPanel_LeftPanel.setModel(assetsModel);
        this.jTable_jScrollPanel_LeftPanel = table;
        jScrollPanel_LeftPanel.setViewportView(jTable_jScrollPanel_LeftPanel);

        // UPDATE FILTER ON TEXT CHANGE
        searchTextField_SearchToolBar_LeftPanel.getDocument().addDocumentListener(new DocumentListener() {
            public void changedUpdate(DocumentEvent e) {
                onChange();
            }

            public void removeUpdate(DocumentEvent e) {
                onChange();
            }

            public void insertUpdate(DocumentEvent e) {
                onChange();
            }

            public void onChange() {

                // GET VALUE
                String search = searchTextField_SearchToolBar_LeftPanel.getText();

                // SET FILTER
                assetsModel.fireTableDataChanged();
                RowFilter filter = RowFilter.regexFilter(".*" + search + ".*", 1);
                ((DefaultRowSorter) sorter).setRowFilter(filter);
                assetsModel.fireTableDataChanged();

            }
        });


        this.jTable_jScrollPanel_LeftPanel.addComponentListener(new ComponentListener() {

            @Override
            public void componentHidden(ComponentEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void componentMoved(ComponentEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void componentResized(ComponentEvent arg0) {
                // TODO Auto-generated method stub

                //	Table_Render("2", pair_Panel.jTable_jScrollPanel_LeftPanel);

                //		new Table_Formats().Table_Row_Auto_Height(table);

            }

            @Override
            public void componentShown(ComponentEvent arg0) {
                // TODO Auto-generated method stub

            }


        });


        //MENU
        JPopupMenu assetsMenu = new JPopupMenu();
        assetsMenu.addAncestorListener(new AncestorListener() {


            @Override
            public void ancestorAdded(AncestorEvent arg0) {
                // TODO Auto-generated method stub
                row = table.getSelectedRow();
                if (row < 1) {
                    assetsMenu.disable();
                }

                row = table.convertRowIndexToModel(row);


            }

            @Override
            public void ancestorMoved(AncestorEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void ancestorRemoved(AncestorEvent arg0) {
                // TODO Auto-generated method stub

            }


        });

        JMenuItem favorite = new JMenuItem(Lang.getInstance().translate("Exchange"));
        favorite.addActionListener(new ActionListener() {
            public void actionPerformed(ActionEvent e) {

                favorite_set(table);

            }
        });


        assetsMenu.addPopupMenuListener(new PopupMenuListener() {

                                            @Override
                                            public void popupMenuCanceled(PopupMenuEvent arg0) {
                                                // TODO Auto-generated method stub

                                            }

                                            @Override
                                            public void popupMenuWillBecomeInvisible(PopupMenuEvent arg0) {
                                                // TODO Auto-generated method stub

                                            }

                                            @Override
                                            public void popupMenuWillBecomeVisible(PopupMenuEvent arg0) {
                                                // TODO Auto-generated method stub

                                                row = table.getSelectedRow();
                                                row = table.convertRowIndexToModel(row);
                                                ImprintCls asset = assetsModel.getItem(row);

                                                //IF ASSET CONFIRMED AND NOT ERM

                                                favorite.setVisible(true);
                                                //CHECK IF FAVORITES
                                                if (Controller.getInstance().isItemFavorite(asset)) {
                                                    favorite.setText(Lang.getInstance().translate("Remove Favorite"));
                                                } else {
                                                    favorite.setText(Lang.getInstance().translate("Add Favorite"));
                                                }
				/*	
				//this.favoritesButton.setPreferredSize(new Dimension(200, 25));
				this.favoritesButton.addActionListener(new ActionListener()
				{
					public void actionPerformed(ActionEvent e)
					{
						onFavoriteClick();
					}
				});	
				this.add(this.favoritesButton, labelGBC);
				*/


                                            }

                                        }

        );


        assetsMenu.add(favorite);

        table.addMouseMotionListener(new MouseMotionListener() {
            public void mouseMoved(MouseEvent e) {

                if (table.columnAtPoint(e.getPoint()) == WalletItemImprintsTableModel.COLUMN_FAVORITE) {

                    table.setCursor(new Cursor(Cursor.HAND_CURSOR));
                } else {
                    table.setCursor(new Cursor(Cursor.DEFAULT_CURSOR));
                }
            }

            public void mouseDragged(MouseEvent e) {
            }
        });

       // table.setComponentPopupMenu(assetsMenu);
        TableMenuPopupUtil.installContextMenu(table, assetsMenu);  // SELECT ROW ON WHICH CLICKED RIGHT BUTTON


        //MOUSE ADAPTER
        table.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                Point p = e.getPoint();
                row = table.rowAtPoint(p);
                table.setRowSelectionInterval(row, row);
            }
        });

        table.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                Point p = e.getPoint();
                row = table.rowAtPoint(p);
                table.setRowSelectionInterval(row, row);


                if (e.getClickCount() == 1 & e.getButton() == e.BUTTON1) {

                    if (table.getSelectedColumn() == WalletItemImprintsTableModel.COLUMN_FAVORITE) {
                        favorite_set(table);
                    }
                }
            }
        });
    }

    public void onIssueClick() {
//	new IssueAssetFrame();
    }

    public void onAllClick() {
//	new AllAssetsFrame();
    }

    public void onMyOrdersClick() {
//	new MyOrdersFrame();
    }

    public void favorite_set(JTable assetsTable) {


        ImprintCls asset = assetsModel.getItem(row);
//new AssetPairSelect(asset.getKey());


        //CHECK IF FAVORITES
        if (Controller.getInstance().isItemFavorite(asset)) {

            Controller.getInstance().removeItemFavorite(asset);
        } else {

            Controller.getInstance().addItemFavorite(asset);
        }


        assetsTable.repaint();


    }

    class My_Tab_Listener implements ListSelectionListener {

        //@SuppressWarnings("deprecation")
        @Override
        public void valueChanged(ListSelectionEvent arg0) {

            ImprintCls imprint = null;
            if (table.getSelectedRow() >= 0)
                imprint = assetsModel.getItem(table.convertRowIndexToModel(table.getSelectedRow()));
            if (imprint == null) return;
            Imprints_Info_Panel info_panel = new Imprints_Info_Panel(imprint);
            info_panel.setPreferredSize(new Dimension(jScrollPane_jPanel_RightPanel.getSize().width - 50, jScrollPane_jPanel_RightPanel.getSize().height - 50));
            jScrollPane_jPanel_RightPanel.setViewportView(info_panel);
        }

    }


}